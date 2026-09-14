"""
LeetSync AI Backend
- /api/videos       → yt-dlp powered YouTube search with full metadata
- /health           → health check
- /{path:path}      → transparent CORS proxy for chat.deepseek.com
"""
import os
import re
import json
import time
import hashlib
import asyncio
import subprocess
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI, Request, Query
from fastapi.responses import StreamingResponse, Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
# ============================================================
#  Config
# ============================================================
CACHE_TTL = 24 * 3600
MAX_CACHE_SIZE = 500
VIDEO_CACHE: dict[str, tuple[float, dict]] = {}
HOP_HEADERS = {
    "connection", "transfer-encoding", "content-length",
    "content-encoding", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "upgrade",
}
# ============================================================
#  Self-ping (Render free tier)
# ============================================================
async def _ping_loop():
    port = os.environ.get("PORT", "8000")
    base = os.environ.get("RENDER_EXTERNAL_URL") or f"http://127.0.0.1:{port}"
    await asyncio.sleep(60)
    while True:
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                await c.get(f"{base}/health")
            print(f"[self-ping] OK {time.strftime('%H:%M:%S')}")
        except Exception as e:
            print(f"[self-ping] failed: {e}")
        await asyncio.sleep(300)
@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_ping_loop())
    try:
        yield
    finally:
        task.cancel()
# ============================================================
#  App
# ============================================================
app = FastAPI(lifespan=lifespan, title="LeetSync AI Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
    allow_credentials=False,
)
# ============================================================
#  Health
# ============================================================
@app.get("/health")
async def health():
    return {"ok": True, "service": "leetsync-ai", "time": int(time.time())}
# ============================================================
#  yt-dlp YouTube search
# ============================================================
def _run(cmd: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
def _flat_search(query: str, n: int) -> list[dict]:
    """Fast: get N video stubs without fetching each one."""
    cmd = [
        "yt-dlp",
        f"ytsearch{n}:{query}",
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
        "--ignore-errors",
    ]
    r = _run(cmd, timeout=25)
    out = []
    for line in r.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out
def _full_details(video_id: str) -> dict | None:
    """Slow: complete metadata for one video (likes, views, best thumbnail)."""
    cmd = [
        "yt-dlp",
        f"https://www.youtube.com/watch?v={video_id}",
        "--dump-json",
        "--no-warnings",
        "--skip-download",
        "--ignore-errors",
    ]
    r = _run(cmd, timeout=25)
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return json.loads(r.stdout.strip().split("\n")[0])
    except Exception:
        return None
def _pick_thumbnail(info: dict) -> str | None:
    thumbs = info.get("thumbnails") or []
    # Prefer ~320x180 for list cards
    for t in thumbs:
        w = t.get("width") or 0
        if 240 <= w <= 480:
            return t.get("url")
    # Fallback: medium quality by video id
    vid = info.get("id")
    if vid:
        return f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
    return thumbs[-1].get("url") if thumbs else None
def _normalize(info: dict) -> dict | None:
    if not info or not info.get("id"):
        return None
    return {
        "id": info.get("id"),
        "title": info.get("title") or "",
        "channel": info.get("uploader") or info.get("channel") or "",
        "channelUrl": info.get("uploader_url") or info.get("channel_url") or "",
        "duration": info.get("duration_string") or "",
        "durationSec": info.get("duration") or 0,
        "views": info.get("view_count") or 0,
        "likes": info.get("like_count") or 0,
        "uploadDate": info.get("upload_date") or "",
        "thumbnail": _pick_thumbnail(info),
        "url": f"https://www.youtube.com/watch?v={info.get('id')}",
    }
def _sweep_video_cache() -> None:
    """Drop expired entries, then the oldest, until we're under the cap."""
    if len(VIDEO_CACHE) <= MAX_CACHE_SIZE:
        return
    now = time.time()
    # Pass 1: drop everything past TTL
    expired = [k for k, (ts, _) in VIDEO_CACHE.items() if now - ts > CACHE_TTL]
    for k in expired:
        VIDEO_CACHE.pop(k, None)
    # Pass 2: if still over, drop oldest by insertion time
    if len(VIDEO_CACHE) > MAX_CACHE_SIZE:
        overflow = len(VIDEO_CACHE) - MAX_CACHE_SIZE
        oldest = sorted(VIDEO_CACHE.items(), key=lambda kv: kv[1][0])[:overflow]
        for k, _ in oldest:
            VIDEO_CACHE.pop(k, None)
@app.get("/api/videos")
def api_videos(q: str = Query(..., min_length=2), n: int = 8):
    key = hashlib.md5(f"{q.lower().strip()}|{n}".encode()).hexdigest()
    cached = VIDEO_CACHE.get(key)
    if cached and time.time() - cached[0] < CACHE_TTL:
        return cached[1]
    flat = _flat_search(q, n)
    if not flat:
        return {"results": []}
    ids = [f.get("id") for f in flat if f.get("id")]
    details: list[dict | None] = []
    if ids:
        with ThreadPoolExecutor(max_workers=min(8, len(ids))) as ex:
            details = list(ex.map(_full_details, ids))
    merged = []
    for i, d in enumerate(details):
        if d:
            merged.append(_normalize(d))
        elif i < len(flat):
            merged.append(_normalize(flat[i]))
    merged = [m for m in merged if m]
    payload = {"results": merged}
    _sweep_video_cache()
    VIDEO_CACHE[key] = (time.time(), payload)
    return payload
# ============================================================
#  DeepSeek CORS proxy (catch-all)
# ============================================================
@app.options("/{path:path}")
async def cors_preflight(path: str):
    return Response(
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS,PATCH",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400",
        },
    )
@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
)
async def proxy(request: Request, path: str):
    target = path
    if request.url.query:
        target += "?" + request.url.query
    if not target.startswith(("http://", "https://")):
        return JSONResponse(
            {"error": "Invalid target URL", "hint": "Use /<https://host/path>"},
            status_code=400,
        )
    # Normalize headers
    fwd: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() in HOP_HEADERS or k.lower() == "host":
            continue
        fwd[k] = v
    # DeepSeek-friendly defaults
    if "deepseek.com" in target:
        fwd.setdefault("Origin", "https://chat.deepseek.com")
        fwd.setdefault("Referer", "https://chat.deepseek.com/")
        fwd.setdefault(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        )
        # Avoid double-decoding
        fwd.setdefault("Accept-Encoding", "identity")
    body = await request.body()
    client = httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=15.0))
    try:
        req = client.build_request(
            method=request.method,
            url=target,
            headers=fwd,
            content=body,
        )
        resp = await client.send(req, stream=True)
    except httpx.RequestError as e:
        await client.aclose()
        return JSONResponse({"error": f"Upstream failed: {e}"}, status_code=502)
    out_headers = {
        k: v for k, v in resp.headers.items()
        if k.lower() not in HOP_HEADERS
    }
    out_headers["Access-Control-Allow-Origin"] = "*"
    out_headers["Access-Control-Expose-Headers"] = "*"
    async def stream_body():
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()
    return StreamingResponse(
        stream_body(),
        status_code=resp.status_code,
        headers=out_headers,
        media_type=resp.headers.get("content-type"),
    )
# ============================================================
#  Local dev entry point
# ============================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

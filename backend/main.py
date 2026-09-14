"""
LeetSync AI Backend
- /api/videos       → yt-dlp powered YouTube search (flat, fast)
- /health           → health check
- /{path:path}      → transparent CORS proxy for chat.deepseek.com
"""
import os
import json
import time
import hashlib
import asyncio
import subprocess
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
#  Self-ping
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
#  yt-dlp YouTube search — flat only, no metadata enrichment
# ============================================================
def _run(cmd: list[str], timeout: int = 25) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _fmt_duration(sec) -> str:
    if not sec:
        return ""
    try:
        sec = int(sec)
    except Exception:
        return ""
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _flat_search(query: str, n: int) -> list[dict]:
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


def _sweep_video_cache() -> None:
    if len(VIDEO_CACHE) <= MAX_CACHE_SIZE:
        return
    now = time.time()
    expired = [k for k, (ts, _) in VIDEO_CACHE.items() if now - ts > CACHE_TTL]
    for k in expired:
        VIDEO_CACHE.pop(k, None)
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

    results = []
    for f in flat:
        vid = f.get("id")
        if not vid:
            continue
        results.append({
            "id": vid,
            "title": f.get("title") or "",
            "channel": f.get("uploader") or f.get("channel") or "",
            "channelUrl": f.get("uploader_url") or f.get("channel_url") or "",
            "duration": f.get("duration_string") or _fmt_duration(f.get("duration")),
            "durationSec": f.get("duration") or 0,
            "views": f.get("view_count") or 0,
            "likes": 0,
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
            "url": f"https://www.youtube.com/watch?v={vid}",
        })

    payload = {"results": results}
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

    fwd: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() in HOP_HEADERS or k.lower() == "host":
            continue
        fwd[k] = v

    if "deepseek.com" in target:
        fwd.setdefault("Origin", "https://chat.deepseek.com")
        fwd.setdefault("Referer", "https://chat.deepseek.com/")
        fwd.setdefault(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        )
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

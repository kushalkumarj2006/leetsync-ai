# LeetSync AI Backend

Single FastAPI service that powers the LeetSync AI Chrome extension.

- **DeepSeek proxy** — transparent CORS-forwarding proxy for `chat.deepseek.com` (handles SSE streaming)
- **YouTube search** — yt-dlp based search returning full metadata (title, channel, duration, views, likes, thumbnail)

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Health check + keep-alive target |
| GET | `/api/videos?q=…&n=8` | YouTube video search via yt-dlp |
| ANY | `/<https://host/path>` | Transparent proxy (used for DeepSeek) |

## Local dev

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
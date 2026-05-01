# Transcript proxy

Tiny zero-dependency Node server that fetches YouTube transcripts via `yt-dlp`. The Chrome extension calls `GET /transcript?id=VIDEO_ID` and gets back `{id, transcript}`.

## Why this exists

YouTube's `timedtext` endpoint silently returns empty bodies to anonymous external requests. `yt-dlp` solves the JS challenges YouTube serves and gets the captions. So we run yt-dlp behind a small HTTP proxy.

## Local dev

```sh
brew install yt-dlp        # or: pipx install yt-dlp
node server.js
curl 'http://localhost:8787/transcript?id=dQw4w9WgXcQ'
```

## Deploying for friends to use

The extension (running on `https://www.youtube.com`) needs to call your server over HTTPS. Pick any host that gives free TLS:

### Fly.io (recommended)

```sh
cd server
fly launch --no-deploy --copy-config --name yt-transcript
fly deploy
```

Fly provides `https://yt-transcript.fly.dev` automatically. Free tier is plenty for this.

### Render / Railway / Koyeb

All accept the included `Dockerfile`. Point them at this directory, expose port 8787, deploy.

### Self-hosted with Cloudflare Tunnel

If you have a Linux box at home:

```sh
docker build -t yt-transcript .
docker run -d -p 8787:8787 --restart=unless-stopped yt-transcript
cloudflared tunnel --url http://localhost:8787   # gives you a *.trycloudflare.com URL
```

## Configuration

Environment variables:

| Var                  | Default        | Notes                                       |
|----------------------|----------------|---------------------------------------------|
| `PORT`               | `8787`         |                                             |
| `CACHE_TTL_MS`       | `86400000`     | 24h. Transcripts rarely change.             |
| `CACHE_MAX`          | `5000`         | LRU cap.                                    |
| `RATE_MAX`           | `60`           | Requests per IP per window.                 |
| `RATE_WINDOW_MS`     | `60000`        | Window length.                              |
| `YTDLP_CONCURRENCY`  | `3`            | Concurrent yt-dlp invocations.              |
| `ALLOWED_ORIGIN`     | `*`            | Set to `https://www.youtube.com` to lock down. |

## Operational notes

- **yt-dlp updates often.** YouTube breaks things every few weeks; `yt-dlp` releases catch up within a day or two. Rebuild the Docker image (`fly deploy` again) when fetches start failing.
- **Resource use.** ~80MB RAM, low CPU. Each yt-dlp run takes 2–6 seconds and downloads a few hundred KB. Cache hits are free.
- **Rate limiting.** Default 60 req/min/IP. Tighten via env if you're worried about abuse.
- **No auth by default.** If you don't want randos using your server, put it behind Cloudflare Access or add a shared-token check (5 lines in `server.js`).

## Endpoints

- `GET /health` → `{"ok":true}`
- `GET /transcript?id=XXXXXXXXXXX` → `{id, transcript}` or `{error}` (4xx/5xx)

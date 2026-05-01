# YouTube Bullshit Detector

Chrome extension that scores YouTube homepage videos by **transcript content** (not just title) on a 0–100 clickbait/bullshit scale, with a one-sentence summary, overlaid on each thumbnail. No interaction required.

## Architecture

```
youtube.com tile
      │
      │ 1. extension reads video ID from DOM
      ▼
your transcript server  ── runs yt-dlp ──▶ youtube.com (gets captions)
      │
      │ 2. returns plain-text transcript
      ▼
extension service worker ── batches 3 ──▶ Anthropic API (Claude Haiku)
      │
      │ 3. score + summary
      ▼
overlay on the thumbnail
```

Two pieces:

- **`/server`** — a small Node + yt-dlp HTTP service you deploy once. YouTube's caption endpoints don't work for plain `fetch()` anymore, so transcript fetching has to happen server-side. See `server/README.md` for deployment.
- **The extension** — everything in the root. Each user installs and provides their own Anthropic API key.

Each user pays for their own LLM calls; the server only fetches public captions and is cheap enough to host on a free tier.

## Setup (you, the deployer)

1. **Deploy the transcript server** somewhere with HTTPS. Easiest path is Fly.io:

   ```sh
   cd server
   fly launch --no-deploy --copy-config --name yt-transcript-yourhandle
   fly deploy
   ```

   You'll get a URL like `https://yt-transcript-yourhandle.fly.dev`. See `server/README.md` for other hosts.

2. **Test it:**

   ```sh
   curl 'https://yt-transcript-yourhandle.fly.dev/transcript?id=dQw4w9WgXcQ'
   ```

3. **Share the extension folder** with anyone who wants it. They install it the same way you do (below) and enter your server URL in the popup.

## Setup (each user)

1. Get an Anthropic API key at <https://console.anthropic.com/settings/keys>. Add a few dollars of credit — Haiku 4.5 is cheap.
2. In Chrome, go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select this folder.
3. Click the extension icon. Paste:
   - Anthropic API key
   - Transcript server URL (the one your friend deployed, or your own)
4. Approve the permission prompt for the server URL.
5. Reload `youtube.com`. Scores and summaries appear on each tile after a second or two.

## How the score works

- **0–20 LEGIT** — substantive, dense, novel content
- **21–40 MILD** — mostly substantive, some filler
- **41–60 MEH** — mixed; real content but heavily padded
- **61–80 BAIT** — mostly empty; rambling, recycled, manufactured drama
- **81–100 SLOP** — pure clickbait, AI patter, content-free

Judgement is based on the transcript, not the title. Title is passed only as context.

If a video has no captions / is a live stream / is age-restricted, you'll see a gray **NO TRANSCRIPT** badge instead of a score.

## Costs

- Anthropic: ~$0.001–0.003 per video on Haiku 4.5 with prompt caching. ~30 videos per pageload = ~$0.03 worst case, much less with cache.
- Server: ~$0/month on Fly.io free tier. yt-dlp uses ~80MB RAM idle, scales with concurrent requests.

## Privacy

- Anthropic API key is stored in `chrome.storage.local` on the user's machine. Never sent anywhere except `api.anthropic.com`.
- Transcript fetches go through your server. The server logs which video IDs were requested, by IP. It does not log API keys (it never sees them).
- Both transcripts and scores are sent to Anthropic for classification.

## Files

```
manifest.json       extension manifest
background.js       service worker; calls Anthropic API
content.js          injected into youtube.com; finds tiles, calls server, renders overlays
content.css         overlay styling
popup.html / .js    settings UI
server/server.js    transcript proxy
server/Dockerfile   for Fly.io / Render / any Docker host
server/fly.toml     Fly.io config
server/README.md    server deployment guide
```

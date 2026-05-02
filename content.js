const seen = new Map();

function extractVideoId(href) {
  if (!href) return null;
  try {
    const u = new URL(href, location.origin);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2];
  } catch {}
  return null;
}

function findTiles() {
  return document.querySelectorAll(
    "ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer"
  );
}

function getTileMeta(tile) {
  const titleEl =
    tile.querySelector("a#video-title-link #video-title") ||
    tile.querySelector("#video-title-link") ||
    tile.querySelector("a#video-title") ||
    tile.querySelector("#video-title") ||
    tile.querySelector("h3 a");
  if (!titleEl) return null;

  const title = (titleEl.getAttribute("title") || titleEl.textContent || "")
    .trim();
  if (!title) return null;

  const linkEl =
    tile.querySelector("a#thumbnail") ||
    tile.querySelector("a#video-title-link") ||
    titleEl.closest("a");
  const href = linkEl ? linkEl.getAttribute("href") : null;
  const videoId = extractVideoId(href);
  if (!videoId) return null;

  return { id: videoId, title };
}

function colorFor(bs) {
  const clamped = Math.max(0, Math.min(100, bs));
  const hue = 140 - (clamped / 100) * 140;
  return `hsl(${hue.toFixed(0)}, 75%, 42%)`;
}

function labelFor(bs) {
  if (bs <= 20) return "LEGIT";
  if (bs <= 40) return "MILD";
  if (bs <= 60) return "MEH";
  if (bs <= 80) return "BAIT";
  return "SLOP";
}

function ensureOverlay(tile) {
  let overlay = tile.querySelector(":scope > .bsd-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "bsd-overlay";
    const thumb =
      tile.querySelector("ytd-thumbnail") ||
      tile.querySelector("#thumbnail") ||
      tile;
    if (getComputedStyle(thumb).position === "static") {
      thumb.style.position = "relative";
    }
    thumb.appendChild(overlay);
  }
  return overlay;
}

function renderScore(tile, result) {
  const overlay = ensureOverlay(tile);
  const bs = result.bs;
  const color = colorFor(bs);
  const label = labelFor(bs);
  overlay.innerHTML = `
    <div class="bsd-badge" style="background:${color}">
      <span class="bsd-score">${bs}</span>
      <span class="bsd-label">${label}</span>
    </div>
    <div class="bsd-summary" style="border-left-color:${color}">${escapeHtml(
    result.summary || ""
  )}</div>
  `;
}

function renderPending(tile) {
  const overlay = ensureOverlay(tile);
  overlay.innerHTML = `<div class="bsd-badge bsd-pending"><span class="bsd-label">…</span></div>`;
}

function renderError(tile, msg) {
  const overlay = ensureOverlay(tile);
  overlay.innerHTML = `
    <div class="bsd-badge bsd-err" title="${escapeHtml(msg)}">
      <span class="bsd-label">NO TRANSCRIPT</span>
    </div>
    <div class="bsd-summary bsd-err-summary">${escapeHtml(msg)}</div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class Limiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.max) {
      await new Promise((r) => this.queue.push(r));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
const transcriptLimiter = new Limiter(4);

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  if (!serverUrl) throw new Error("no server URL configured (open popup)");
  return serverUrl;
}

async function fetchTranscript(videoId) {
  const base = await getServerUrl();
  const res = await fetch(
    `${base}/transcript?id=${encodeURIComponent(videoId)}`
  );
  if (res.status === 429) throw new Error("server rate limit; try again soon");
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("bad response from server (HTTP " + res.status + ")");
  }
  if (!res.ok) throw new Error(body.error || "server error " + res.status);
  if (!body.transcript) throw new Error("empty transcript");
  return body.transcript;
}

function classify(item) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "classify", item }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: "no response" });
      }
    });
  });
}

async function processTile(tile) {
  const meta = getTileMeta(tile);
  if (!meta) return;
  const key = meta.id;
  if (seen.has(key)) {
    const cached = seen.get(key);
    if (cached) {
      if (cached.kind === "score") renderScore(tile, cached);
      else renderError(tile, cached.error);
    }
    return;
  }
  seen.set(key, null);
  renderPending(tile);

  let transcript;
  try {
    transcript = await transcriptLimiter.run(() => fetchTranscript(meta.id));
  } catch (err) {
    const msg = String(err.message || err);
    seen.set(key, { kind: "error", error: msg });
    renderError(tile, msg);
    return;
  }

  const result = await classify({
    id: meta.id,
    title: meta.title,
    transcript,
  });
  if (!result.ok) {
    seen.set(key, { kind: "error", error: result.error || "classify failed" });
    renderError(tile, result.error || "classify failed");
    return;
  }
  const stored = { kind: "score", bs: result.bs, summary: result.summary };
  seen.set(key, stored);
  renderScore(tile, stored);
}

// IntersectionObserver: only process tiles when they're visible (or about to be).
// rootMargin pre-fetches a viewport ahead so scrolling feels instant.
const visibility = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const tile = e.target;
      visibility.unobserve(tile);
      processTile(tile);
    }
  },
  { rootMargin: "800px 0px 800px 0px", threshold: 0 }
);

function scan() {
  for (const tile of findTiles()) {
    if (tile.dataset.bsdScanned) continue;
    tile.dataset.bsdScanned = "1";
    visibility.observe(tile);
  }
}

const mutationObserver = new MutationObserver(() => scheduleScan());

let scanTimer = null;
function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, 200);
}

mutationObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

scheduleScan();

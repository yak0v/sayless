// SlopShield content script. Runs on youtube.com.
//
// Everything happens client-side: captions are fetched straight from
// YouTube's InnerTube API (same-origin, so no server and no CORS), and
// scoring goes through the service worker (background.js), which talks
// to the Anthropic API and keeps a persistent score cache.

"use strict";

const TRANSCRIPT_FETCH_CONCURRENCY = 6;
const TRANSIENT_RETRY_DELAYS_MS = [3000, 8000];

// ---------------------------------------------------------------------------
// Caption fetching via InnerTube
// ---------------------------------------------------------------------------

// The ANDROID client returns caption track URLs that work without a PO
// token; the web client's don't. Requests are same-origin (we run on
// youtube.com), sent without cookies to match the anonymous player API.
const INNERTUBE_CONTEXT = {
  client: {
    clientName: "ANDROID",
    clientVersion: "20.10.38",
    androidSdkVersion: 34,
    hl: "en",
  },
};

class TranscriptError extends Error {
  constructor(message, permanent) {
    super(message);
    this.permanent = permanent;
  }
}

// manual English > auto English > any manual > anything
function captionTrackScore(track) {
  const en = (track.languageCode || "").toLowerCase().startsWith("en");
  const manual = track.kind !== "asr";
  return (en ? 2 : 0) + (manual ? 1 : 0);
}

function decodeXmlEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseJson3(json) {
  return (json.events || [])
    .flatMap((e) => e.segs || [])
    .map((s) => s.utf8 || "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

// <timedtext format="3"> XML: text lives in <p> (and nested <s>) elements.
function parseSrv3(xml) {
  const body = xml.replace(/<[^>]+>/g, " ");
  return decodeXmlEntities(body).replace(/\s+/g, " ").trim();
}

async function fetchTranscript(videoId) {
  const playerRes = await fetch(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: INNERTUBE_CONTEXT, videoId }),
    }
  );
  if (!playerRes.ok) {
    throw new TranscriptError(`player API HTTP ${playerRes.status}`, false);
  }
  const player = await playerRes.json();

  const status = player.playabilityStatus?.status;
  if (status === "ERROR") {
    throw new TranscriptError("video unavailable", true);
  }
  if (status !== "OK") {
    // LOGIN_REQUIRED (age-gated) etc. — nothing we can do client-side.
    throw new TranscriptError(`video is ${status || "unplayable"}`, true);
  }

  const tracks =
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (tracks.length === 0) {
    throw new TranscriptError("no captions", true);
  }
  const track = tracks
    .slice()
    .sort((a, b) => captionTrackScore(b) - captionTrackScore(a))[0];

  const capRes = await fetch(track.baseUrl + "&fmt=json3", {
    credentials: "omit",
  });
  if (!capRes.ok) {
    throw new TranscriptError(`timedtext HTTP ${capRes.status}`, false);
  }
  const raw = await capRes.text();
  if (!raw) throw new TranscriptError("empty timedtext response", false);

  // YouTube sometimes ignores fmt=json3 and serves srv3 XML; handle both.
  const text = raw.trimStart().startsWith("{")
    ? parseJson3(JSON.parse(raw))
    : parseSrv3(raw);
  if (!text) throw new TranscriptError("empty transcript", true);
  return text;
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
const transcriptLimiter = new Limiter(TRANSCRIPT_FETCH_CONCURRENCY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTranscriptWithRetry(videoId) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transcriptLimiter.run(() => fetchTranscript(videoId));
    } catch (err) {
      if (err.permanent || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
    }
  }
}

// ---------------------------------------------------------------------------
// Scoring via the service worker
// ---------------------------------------------------------------------------

// When the extension is reloaded or updated, content scripts already
// running in open tabs are orphaned: chrome.runtime disappears and any
// call into it throws. Detect that and fail cleanly instead of leaving
// badges stuck on pending.
let contextDead = false;

function extensionAlive() {
  try {
    return !contextDead && Boolean(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

const CONTEXT_DEAD_ERROR = "SlopShield was updated - reload this page";

// Pause switch (popup button). While paused: no transcript fetches, no API
// calls, badges hidden. Flipping it back on rescans without a page reload.
let paused = false;

function applyPaused(value) {
  paused = Boolean(value);
  document.documentElement.classList.toggle("sl-paused", paused);
  if (!paused) scheduleScan();
}

try {
  chrome.storage.local.get("paused", ({ paused: p }) => applyPaused(p));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "paused" in changes) {
      applyPaused(changes.paused.newValue);
    }
  });
} catch {
  // Extension context already gone; nothing to pause.
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    if (!extensionAlive()) {
      contextDead = true;
      resolve({ ok: false, error: CONTEXT_DEAD_ERROR });
      return;
    }
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, error: "no response from extension" });
        }
      });
    } catch {
      contextDead = true;
      resolve({ ok: false, error: CONTEXT_DEAD_ERROR });
    }
  });
}

// results holds finished outcomes worth keeping for the page's lifetime:
// scores and permanent errors. Transient errors are not stored, so a video
// gets another chance if its tile is re-rendered.
const results = new Map();
const inflight = new Map();

function getResult(meta) {
  if (results.has(meta.id)) return Promise.resolve(results.get(meta.id));
  if (inflight.has(meta.id)) return inflight.get(meta.id);
  const promise = computeResult(meta)
    .then((r) => {
      if (r.kind === "score" || r.permanent) results.set(meta.id, r);
      return r;
    })
    .finally(() => inflight.delete(meta.id));
  inflight.set(meta.id, promise);
  return promise;
}

async function computeResult(meta) {
  const cached = await sendMessage({ type: "getCachedScore", id: meta.id });
  if (contextDead) {
    return { kind: "error", error: CONTEXT_DEAD_ERROR, permanent: false };
  }
  if (cached && cached.ok && cached.score) {
    return { kind: "score", ...cached.score };
  }

  let transcript;
  try {
    transcript = await fetchTranscriptWithRetry(meta.id);
  } catch (err) {
    return {
      kind: "error",
      error: String(err.message || err),
      permanent: Boolean(err.permanent),
    };
  }

  const res = await sendMessage({
    type: "classify",
    video: { id: meta.id, title: meta.title, transcript },
  });
  if (!res.ok) {
    return { kind: "error", error: res.error || "scoring failed", permanent: false };
  }
  return { kind: "score", bs: res.bs, summary: res.summary };
}

// ---------------------------------------------------------------------------
// Overlay rendering
// ---------------------------------------------------------------------------

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findThumbnail(tile) {
  return (
    tile.querySelector("ytd-thumbnail") ||
    tile.querySelector("yt-thumbnail-view-model") ||
    tile.querySelector("#thumbnail") ||
    tile.querySelector('a[href*="/watch?"], a[href^="/shorts/"]') ||
    tile
  );
}

function ensureOverlay(tile) {
  let overlay = tile.querySelector(".sl-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "sl-overlay";
    const thumb = findThumbnail(tile);
    if (getComputedStyle(thumb).position === "static") {
      thumb.style.position = "relative";
    }
    thumb.appendChild(overlay);
  }
  return overlay;
}

function renderPending(overlay) {
  overlay.innerHTML = `<div class="sl-badge sl-pending"><span class="sl-label">&hellip;</span></div>`;
}

function renderResult(overlay, result) {
  if (result.kind === "score") {
    const color = colorFor(result.bs);
    overlay.innerHTML = `
      <div class="sl-badge" style="background:${color}">
        <span class="sl-score">${result.bs}</span>
        <span class="sl-label">${labelFor(result.bs)}</span>
      </div>
      <div class="sl-summary" style="border-left-color:${color}">${escapeHtml(
      result.summary || ""
    )}</div>
    `;
  } else {
    const label = result.permanent ? "NO CAPTIONS" : "ERROR";
    overlay.innerHTML = `
      <div class="sl-badge sl-err" title="${escapeHtml(result.error)}">
        <span class="sl-label">${label}</span>
      </div>
      <div class="sl-summary sl-err-summary">${escapeHtml(result.error)}</div>
    `;
  }
}

// ---------------------------------------------------------------------------
// Tile discovery
// ---------------------------------------------------------------------------

// Known video tile containers, old and new YouTube layouts alike.
const TILE_SELECTOR = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "yt-lockup-view-model",
].join(", ");

function extractVideoId(href) {
  if (!href) return null;
  try {
    const u = new URL(href, location.origin);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2];
  } catch {}
  return null;
}

function getTileMeta(tile) {
  const link = tile.querySelector('a[href*="/watch?"], a[href^="/shorts/"]');
  const videoId = extractVideoId(link && link.getAttribute("href"));
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;

  const titleEl = tile.querySelector(
    '#video-title, [class*="__title"], h3, [title]'
  );
  const title = (
    (titleEl && (titleEl.getAttribute("title") || titleEl.textContent)) ||
    (link && link.getAttribute("aria-label")) ||
    ""
  )
    .trim()
    .slice(0, 300);

  return { id: videoId, title };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// YouTube recycles tile elements: the same DOM node can be reused for a
// different video. So tiles are never marked "done" — instead the overlay
// remembers which video it was rendered for (dataset.videoId), and a tile
// is (re)processed whenever its current video doesn't match.
async function processTile(tile) {
  if (contextDead || paused) return;
  const meta = getTileMeta(tile);
  if (!meta) return;

  const overlay = ensureOverlay(tile);
  if (overlay.dataset.videoId === meta.id) return;
  overlay.dataset.videoId = meta.id;
  renderPending(overlay);

  const result = await getResult(meta);
  // The tile may have been recycled for another video while we worked.
  if (overlay.dataset.videoId !== meta.id || !overlay.isConnected) return;
  renderResult(overlay, result);
}

const visibleTiles = new Set();

const visibility = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        visibleTiles.add(e.target);
        processTile(e.target);
      } else {
        visibleTiles.delete(e.target);
      }
    }
  },
  { rootMargin: "600px 0px 600px 0px", threshold: 0 }
);

const observedTiles = new WeakSet();

function scan() {
  for (const tile of document.querySelectorAll(TILE_SELECTOR)) {
    // Skip nested matches (a lockup inside a rich-item) — observe the outer.
    if (tile.parentElement && tile.parentElement.closest(TILE_SELECTOR)) {
      continue;
    }
    if (!observedTiles.has(tile)) {
      observedTiles.add(tile);
      visibility.observe(tile);
    }
  }
  // Recheck visible tiles: DOM mutations may have recycled one for a new
  // video without creating a new element.
  for (const tile of visibleTiles) {
    if (tile.isConnected) processTile(tile);
  }
}

let scanTimer = null;
function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, 300);
}

new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

scheduleScan();

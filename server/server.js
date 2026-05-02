// Transcript proxy. Run: node server.js
// GET /transcript?id=VIDEO_ID -> {id, transcript}
// Requires yt-dlp on PATH.

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const CACHE_MAX = Number(process.env.CACHE_MAX || 5000);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const RATE_MAX = Number(process.env.RATE_MAX || 60);
const YTDLP_CONCURRENCY = Number(process.env.YTDLP_CONCURRENCY || 2);
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 45_000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// --- LRU cache (insertion order) ---
const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL_MS) {
    cache.delete(k);
    return null;
  }
  cache.delete(k);
  cache.set(k, e);
  return e.v;
}
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(k, { v, t: Date.now() });
}

// --- Per-IP sliding window rate limit ---
const rateBuckets = new Map();
function checkRate(ip) {
  const now = Date.now();
  const arr = (rateBuckets.get(ip) || []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  if (arr.length >= RATE_MAX) {
    rateBuckets.set(ip, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(ip, arr);
  return true;
}

// --- Concurrency limiter ---
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
const ytdlpLimiter = new Limiter(YTDLP_CONCURRENCY);

// --- Inflight dedup ---
const inflight = new Map();

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      p.kill("SIGKILL");
    }, YTDLP_TIMEOUT_MS);
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error("spawn failed: " + e.message));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (killed)
        return reject(
          new Error(`yt-dlp timed out after ${YTDLP_TIMEOUT_MS}ms`)
        );
      if (code === 0) resolve();
      else
        reject(
          new Error(`yt-dlp exit ${code}: ${stderr.slice(-300).trim()}`)
        );
    });
  });
}

function parseJson3(json) {
  return (json.events || [])
    .flatMap((e) => e.segs || [])
    .map((s) => s.utf8 || "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchTranscript(videoId) {
  return ytdlpLimiter.run(async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "yt-"));
    try {
      await runYtDlp([
        "--skip-download",
        "--write-auto-sub",
        "--write-sub",
        "--sub-format",
        "json3",
        "--sub-lang",
        "en",
        "--no-warnings",
        "--no-progress",
        "--socket-timeout",
        "10",
        "--retries",
        "1",
        "--extractor-args",
        "youtube:player_skip=webpage,configs",
        "-o",
        path.join(tmp, "%(id)s"),
        `https://www.youtube.com/watch?v=${videoId}`,
      ]);
      const files = await fsp.readdir(tmp);
      const subFile = files.find((f) => f.endsWith(".json3"));
      if (!subFile) throw new Error("no captions available");
      const raw = await fsp.readFile(path.join(tmp, subFile), "utf8");
      const text = parseJson3(JSON.parse(raw));
      if (!text) throw new Error("empty transcript");
      return text;
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function getTranscript(videoId) {
  const hit = cacheGet(videoId);
  if (hit) return hit;
  if (inflight.has(videoId)) return inflight.get(videoId);

  const promise = (async () => {
    const t0 = Date.now();
    try {
      const text = await fetchTranscript(videoId);
      log(`OK ${videoId} (${text.length}c, ${Date.now() - t0}ms)`);
      cacheSet(videoId, text);
      return text;
    } catch (err) {
      log(`FAIL ${videoId}: ${err.message}`);
      throw err;
    } finally {
      inflight.delete(videoId);
    }
  })();

  inflight.set(videoId, promise);
  return promise;
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function send(res, status, body, contentType = "application/json") {
  res.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET,OPTIONS",
    "cache-control": "no-store",
    vary: "origin",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") return send(res, 200, '{"ok":true}');

  if (url.pathname === "/transcript") {
    const ip = getClientIp(req);
    if (!checkRate(ip)) {
      return send(res, 429, JSON.stringify({ error: "rate limited" }));
    }
    const id = url.searchParams.get("id");
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
      return send(res, 400, JSON.stringify({ error: "bad id" }));
    }
    try {
      const text = await getTranscript(id);
      return send(res, 200, JSON.stringify({ id, transcript: text }));
    } catch (err) {
      return send(
        res,
        502,
        JSON.stringify({ error: String(err.message || err) })
      );
    }
  }

  send(res, 404, '{"error":"not found"}');
});

server.listen(PORT, () => {
  log(`transcript server listening on :${PORT}`);
  log(
    `cache=${CACHE_MAX} ttl=${CACHE_TTL_MS}ms rate=${RATE_MAX}/${RATE_WINDOW_MS}ms ytdlp_concurrency=${YTDLP_CONCURRENCY}`
  );
});

// SlopShield service worker. Scores video transcripts with the user's chosen
// inference provider and keeps a persistent per-video score cache so nothing
// is paid for twice.

"use strict";

const MAX_BATCH = 4;
const FLUSH_DELAY_MS = 250;
const TRANSCRIPT_CHAR_LIMIT = 6000;
const MAX_TOKENS = 1500;

const SCORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCORE_CACHE_MAX = 10000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `You evaluate YouTube videos for bullshit based on their actual transcript. Bullshit means the video wastes the viewer's time relative to what it presents itself as - not that it lacks educational content.

The title establishes the promise; the transcript shows what is delivered. Score each video 0-100 on how badly it breaks that promise:
- 0-20: delivers exactly what the title promises, densely, with little padding
- 21-40: delivers on the promise, with some filler or rambling
- 41-60: real content buried in heavy padding, or only partially delivers what was promised
- 61-80: mostly empty relative to the promise - long intros, drawn-out non-answers, repetition, vague claims where specifics were promised, heavy shilling
- 81-100: pure slop - never delivers, manufactured outrage with no evidence, AI-generated patter, podcast-clip ragebait, conspiracy nonsense, content-free filler stretched for watch time

Genre is not bullshit. Entertainment, comedy, gaming, vlogs, reactions, and music that honestly are what their title says score LOW even if they teach nothing - a video titled as developers watching a speedrun that is exactly that is legit. Never penalize a video for lacking substance it never promised. Informational framing raises the bar: a video promising answers, analysis, or news is judged on whether it actually delivers specifics.

Heuristics for high scores: the transcript never gets to what the title teases, minutes of intro before any substance, repeating the same point, vague claims with no specifics, heavy ad/sponsor reads relative to content, AI narration patterns (uniform pacing, generic phrasings), reading headlines without analysis.

Heuristics for low scores: delivers the promised thing promptly and densely - whether that is specific data, citations, technical detail, and demonstrated expertise, or simply the honest entertainment the title described.

Return one rating per input video, in the same order, echoing each video's id exactly. The summary is ONE sentence, max 18 words, plain text describing what the video actually contains.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ratings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          bs: { type: "integer" },
          summary: { type: "string" },
        },
        required: ["id", "bs", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["ratings"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Persistent score cache (chrome.storage.local)
// ---------------------------------------------------------------------------

const scoreKey = (id) => "score:" + id;

// Bump whenever the scoring rubric changes so stale scores are recomputed.
const RUBRIC_VERSION = 2;

async function getCachedScore(id) {
  const key = scoreKey(id);
  const obj = await chrome.storage.local.get(key);
  const entry = obj[key];
  if (
    !entry ||
    entry.v !== RUBRIC_VERSION ||
    Date.now() - entry.t > SCORE_TTL_MS
  ) {
    return null;
  }
  return { bs: entry.bs, summary: entry.summary };
}

function storeScore(id, bs, summary) {
  chrome.storage.local.set({
    [scoreKey(id)]: { v: RUBRIC_VERSION, bs, summary, t: Date.now() },
  });
}

async function pruneScores() {
  const { lastPrune } = await chrome.storage.local.get("lastPrune");
  if (lastPrune && Date.now() - lastPrune < PRUNE_INTERVAL_MS) return;
  await chrome.storage.local.set({ lastPrune: Date.now() });

  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith("score:"));
  const now = Date.now();
  const dead = new Set(
    entries.filter(([, v]) => now - v.t > SCORE_TTL_MS).map(([k]) => k)
  );
  const live = entries.filter(([k]) => !dead.has(k));
  if (live.length > SCORE_CACHE_MAX) {
    live
      .sort((a, b) => a[1].t - b[1].t)
      .slice(0, live.length - SCORE_CACHE_MAX)
      .forEach(([k]) => dead.add(k));
  }
  if (dead.size) await chrome.storage.local.remove([...dead]);
}

// ---------------------------------------------------------------------------
// Providers. Each call returns the model's response text; Anthropic, OpenAI,
// and Gemini enforce OUTPUT_SCHEMA server-side, while "custom" (any
// OpenAI-compatible endpoint) relies on prompt instructions plus tolerant
// parsing, since schema support varies wildly across compatible servers.
// ---------------------------------------------------------------------------

const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
  gemini: "gemini-2.5-flash",
};

// Gemini's responseSchema dialect: no additionalProperties, uppercase types.
const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    ratings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          bs: { type: "INTEGER" },
          summary: { type: "STRING" },
        },
        required: ["id", "bs", "summary"],
      },
    },
  },
  required: ["ratings"],
};

const JSON_SHAPE_NOTE = `\n\nRespond with ONLY a JSON object, no prose and no code fences: {"ratings":[{"id":"<video id>","bs":<0-100 integer>,"summary":"<one sentence>"}]}`;

async function getSettings() {
  const { settings, apiKey } = await chrome.storage.local.get([
    "settings",
    "apiKey",
  ]);
  if (settings && settings.provider) return settings;
  // Migrate pre-provider installs, where the Anthropic key was stored bare.
  if (apiKey) {
    const migrated = { provider: "anthropic", configs: { anthropic: { apiKey } } };
    await chrome.storage.local.set({ settings: migrated });
    return migrated;
  }
  return null;
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + " ...[truncated]";
}

async function apiError(name, res) {
  if (res.status === 401 || res.status === 403)
    return new Error(`invalid ${name} API key`);
  if (res.status === 429) return new Error(`${name} rate limit`);
  const body = await res.text();
  // Surface the API's human-readable message, not the raw JSON envelope.
  let detail = body.slice(0, 200);
  try {
    const err = JSON.parse(body).error;
    detail = typeof err === "string" ? err : err.message;
  } catch {}
  return new Error(`${name} ${res.status}: ${detail}`);
}

async function callAnthropic(cfg, userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw await apiError("Anthropic", res);

  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("model refused");
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// OpenAI proper gets strict json_schema; custom endpoints get the prompt-level
// JSON_SHAPE_NOTE instead and no token cap (max_completion_tokens vs
// max_tokens is another compatibility minefield, and the output is tiny).
async function callOpenAICompatible(cfg, userText, name, baseUrl, useSchema) {
  const res = await fetch(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { authorization: "Bearer " + cfg.apiKey } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT + (useSchema ? "" : JSON_SHAPE_NOTE),
        },
        { role: "user", content: userText },
      ],
      ...(useSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "ratings", strict: true, schema: OUTPUT_SCHEMA },
            },
          }
        : {}),
    }),
  });
  if (!res.ok) throw await apiError(name, res);

  const data = await res.json();
  const message = data.choices?.[0]?.message;
  if (message?.refusal) throw new Error("model refused");
  if (!message?.content) throw new Error(`empty ${name} response`);
  return message.content;
}

async function callGemini(cfg, userText) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": cfg.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: GEMINI_SCHEMA,
        },
      }),
    }
  );
  if (!res.ok) throw await apiError("Gemini", res);

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .map((p) => p.text || "")
    .join("");
  if (!text) {
    if (candidate?.finishReason === "SAFETY" || data.promptFeedback?.blockReason)
      throw new Error("model refused");
    throw new Error("empty Gemini response");
  }
  return text;
}

// Tolerant of code fences and prose around the JSON (custom endpoints).
function parseRatings(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON in model response");
  const ratings = JSON.parse(text.slice(start, end + 1)).ratings;
  if (!Array.isArray(ratings)) throw new Error("malformed model response");
  return ratings;
}

async function classifyBatch(videos) {
  const settings = await getSettings();
  const provider = settings?.provider;
  const cfg = { ...(settings?.configs?.[provider] || {}) };
  // Custom endpoints (e.g. local Ollama) may legitimately have no key.
  if (!cfg.apiKey && provider !== "custom")
    throw new Error("no API key set (click the SlopShield icon)");
  cfg.model = cfg.model || DEFAULT_MODELS[provider];
  if (!cfg.model) throw new Error("no model set (click the SlopShield icon)");

  const userText =
    "Rate these YouTube videos by transcript content:\n\n" +
    videos
      .map(
        (v) =>
          `--- VIDEO id=${v.id} ---\nTITLE: ${v.title}\nTRANSCRIPT: ${truncate(
            v.transcript,
            TRANSCRIPT_CHAR_LIMIT
          )}`
      )
      .join("\n\n");

  let text;
  if (provider === "anthropic") {
    text = await callAnthropic(cfg, userText);
  } else if (provider === "openai") {
    text = await callOpenAICompatible(
      cfg, userText, "OpenAI", "https://api.openai.com/v1", true
    );
  } else if (provider === "gemini") {
    text = await callGemini(cfg, userText);
  } else if (provider === "custom") {
    if (!cfg.baseUrl)
      throw new Error("no base URL set (click the SlopShield icon)");
    text = await callOpenAICompatible(cfg, userText, "provider", cfg.baseUrl, false);
  } else {
    throw new Error(`unknown provider: ${provider}`);
  }

  return parseRatings(text);
}

// ---------------------------------------------------------------------------
// Batching queue
// ---------------------------------------------------------------------------

const queue = [];
let flushTimer = null;

function enqueue(video) {
  return new Promise((resolve) => {
    queue.push({ video, resolve });
    if (queue.length >= MAX_BATCH) {
      clearTimeout(flushTimer);
      flushTimer = null;
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, FLUSH_DELAY_MS);
    }
  });
}

async function flush() {
  const batch = queue.splice(0, MAX_BATCH);
  if (batch.length === 0) return;

  try {
    const ratings = await classifyBatch(batch.map((b) => b.video));
    const byId = new Map(ratings.map((r) => [String(r.id), r]));
    for (const { video, resolve } of batch) {
      const r = byId.get(video.id);
      if (r) {
        const bs = Math.max(0, Math.min(100, Math.round(r.bs)));
        storeScore(video.id, bs, r.summary);
        resolve({ ok: true, bs, summary: r.summary });
      } else {
        resolve({ ok: false, error: "missing from model response" });
      }
    }
  } catch (err) {
    for (const { resolve } of batch) {
      resolve({ ok: false, error: String(err.message || err) });
    }
  }

  if (queue.length > 0) flush();
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getCachedScore") {
    getCachedScore(msg.id)
      .then((score) => sendResponse({ ok: true, score }))
      .catch(() => sendResponse({ ok: true, score: null }));
    return true;
  }
  if (msg.type === "classify") {
    enqueue(msg.video).then(sendResponse);
    return true;
  }
});

pruneScores();

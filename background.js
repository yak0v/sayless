const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You evaluate YouTube videos for content quality based on their actual transcript. For each video, judge whether the content is substantive/novel/informative or empty filler/clickbait/manufactured drama/AI slop.

Score each video 0-100 on a "bullshit" scale:
- 0-20: substantive, well-researched, novel insight, dense information per minute
- 21-40: mostly substantive with some filler or rambling
- 41-60: mixed — real content but heavily padded or recycled
- 61-80: mostly empty — long intros, repetition, vague claims, shilling, filler dialogue
- 81-100: pure slop — manufactured outrage with no evidence, AI-generated patter, reaction-of-reaction with no original thought, podcast-clip ragebait, conspiracy nonsense, content-free filler

Judge from the TRANSCRIPT CONTENT, not the title. Title is context only — a baity title with substantive content scores low; a calm title with empty content scores high.

Heuristics for high scores: minutes of intro before any substance, repeating the same point, "smash that like button" / "comment below" filler, vague claims with no specifics, heavy ad/sponsor reads relative to content, AI narration patterns (uniform pacing, generic phrasings), reading headlines without analysis, clip-and-react with no original thought.

Heuristics for low scores: specific data/citations/timelines, named sources, technical detail, original research, demonstrated expertise, dense information, tight pacing.

Respond with ONLY a JSON array, one object per input video, in the same order:
[{"id": "<input id>", "bs": <integer 0-100>, "summary": "<one sentence describing what the video actually contains>"}]

Summary: ONE sentence, max 18 words, plain text describing the actual content. No quotes inside.`;

const TRANSCRIPT_CHAR_LIMIT = 6000;

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return apiKey;
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + " ...[truncated]";
}

async function classifyBatch(items) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("No API key set");

  const userText =
    "Rate these YouTube videos by transcript content:\n\n" +
    items
      .map(
        (it) =>
          `--- VIDEO id=${it.id} ---\nTITLE: ${it.title}\nTRANSCRIPT: ${truncate(
            it.transcript || "",
            TRANSCRIPT_CHAR_LIMIT
          )}`
      )
      .join("\n\n") +
    "\n\nReturn the JSON array now.";

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const jsonStart = text.indexOf("[");
  const jsonEnd = text.lastIndexOf("]");
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error("No JSON array in response: " + text.slice(0, 200));
  }
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

const queue = [];
let flushTimer = null;
const FLUSH_DELAY_MS = 250;
const MAX_BATCH = 3;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

async function flush() {
  flushTimer = null;
  if (queue.length === 0) return;

  const batch = queue.splice(0, MAX_BATCH);
  const items = batch.map((b) => b.item);

  try {
    const results = await classifyBatch(items);
    const byId = new Map(results.map((r) => [String(r.id), r]));
    for (const { item, resolve } of batch) {
      const r = byId.get(String(item.id));
      if (r) resolve({ ok: true, bs: r.bs, summary: r.summary });
      else resolve({ ok: false, error: "missing in response" });
    }
  } catch (err) {
    for (const { resolve } of batch) {
      resolve({ ok: false, error: String(err.message || err) });
    }
  }

  if (queue.length > 0) scheduleFlush();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "classify") {
    queue.push({ item: msg.item, resolve: sendResponse });
    scheduleFlush();
    return true;
  }
});

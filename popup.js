"use strict";

const PROVIDERS = {
  anthropic: {
    keyPlaceholder: "sk-ant-...",
    defaultModel: "claude-haiku-4-5",
    note: "Get a key at console.anthropic.com.",
    test: (cfg) =>
      testGet("https://api.anthropic.com/v1/models?limit=1", {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      }),
  },
  openai: {
    keyPlaceholder: "sk-...",
    defaultModel: "gpt-5-mini",
    note: "Get a key at platform.openai.com.",
    test: (cfg) =>
      testGet("https://api.openai.com/v1/models", {
        authorization: "Bearer " + cfg.apiKey,
      }),
  },
  gemini: {
    keyPlaceholder: "AIza...",
    defaultModel: "gemini-2.5-flash",
    note: "Get a key at aistudio.google.com.",
    test: (cfg) =>
      testGet(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        { "x-goog-api-key": cfg.apiKey }
      ),
  },
  custom: {
    keyPlaceholder: "optional for local servers",
    defaultModel: "",
    note: "Any OpenAI-compatible endpoint: Ollama, OpenRouter, Groq, vLLM… Base URL is everything before /chat/completions.",
    test: (cfg) =>
      testGet(cfg.baseUrl.replace(/\/+$/, "") + "/models", {
        ...(cfg.apiKey ? { authorization: "Bearer " + cfg.apiKey } : {}),
      }),
  },
};

const providerSel = document.getElementById("provider");
const baseUrlRow = document.getElementById("baseUrlRow");
const baseUrlInput = document.getElementById("baseUrl");
const keyInput = document.getElementById("key");
const keyHint = document.getElementById("keyHint");
const modelInput = document.getElementById("model");
const modelHint = document.getElementById("modelHint");
const saveBtn = document.getElementById("save");
const toggleInput = document.getElementById("toggle");
const toggleState = document.getElementById("toggleState");
const status = document.getElementById("status");
const note = document.getElementById("note");

function setStatus(msg, isErr) {
  status.textContent = msg;
  status.className = "status " + (isErr ? "err" : "ok");
}

async function testGet(url, headers) {
  const res = await fetch(url, { headers });
  if (res.status === 401 || res.status === 403)
    throw new Error("Invalid API key.");
  if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}.`);
}

// ---------------------------------------------------------------------------
// Settings: { provider, configs: { [provider]: { apiKey, model, baseUrl } } }
// Keys are kept per provider so switching back and forth loses nothing.
// ---------------------------------------------------------------------------

let settings = { provider: "anthropic", configs: {} };

function renderForm() {
  const p = settings.provider;
  const meta = PROVIDERS[p];
  const cfg = settings.configs[p] || {};
  providerSel.value = p;
  baseUrlRow.hidden = p !== "custom";
  baseUrlInput.value = cfg.baseUrl || "";
  keyInput.value = cfg.apiKey || "";
  keyInput.placeholder = meta.keyPlaceholder;
  keyHint.textContent = p === "custom" ? "(optional)" : "";
  modelInput.value = cfg.model || "";
  modelInput.placeholder = meta.defaultModel || "e.g. llama3.3:70b";
  modelHint.textContent = meta.defaultModel
    ? `(blank = ${meta.defaultModel})`
    : "";
  note.textContent =
    meta.note +
    " The key is stored locally in chrome.storage.local and only ever sent" +
    " to that provider. Reload youtube.com after saving.";
}

providerSel.addEventListener("change", () => {
  settings.provider = providerSel.value;
  chrome.storage.local.set({ settings });
  setStatus("", false);
  renderForm();
});

saveBtn.addEventListener("click", async () => {
  const p = settings.provider;
  const cfg = {
    apiKey: keyInput.value.trim(),
    model: modelInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
  };
  if (!cfg.apiKey && p !== "custom") {
    setStatus("Enter an API key.", true);
    return;
  }

  saveBtn.disabled = true;
  try {
    if (p === "custom") {
      if (!/^https?:\/\//.test(cfg.baseUrl))
        throw new Error("Enter a base URL starting with http(s)://.");
      if (!cfg.model) throw new Error("Enter a model name.");
      // Custom endpoints aren't in the manifest; ask for the origin now.
      // Match patterns can't carry a port (and ignore them when matching),
      // so request scheme://host/* rather than URL.origin.
      const u = new URL(cfg.baseUrl);
      const origin = `${u.protocol}//${u.hostname}/*`;
      setStatus("Requesting permission…", false);
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error(`Permission for ${origin} was declined.`);
    }

    setStatus("Testing…", false);
    try {
      await PROVIDERS[p].test(cfg);
    } catch (err) {
      // A custom server may not implement /models; save anyway with a note.
      if (p !== "custom" || String(err.message).includes("Invalid API key"))
        throw err;
      settings.configs[p] = cfg;
      await chrome.storage.local.set({ settings });
      setStatus("Saved. Could not verify endpoint — reload youtube.com and watch for errors.", false);
      return;
    }
    settings.configs[p] = cfg;
    await chrome.storage.local.set({ settings });
    setStatus("Works. Saved — reload youtube.com.", false);
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    saveBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Pause switch. Takes effect in open tabs immediately (no reload): paused
// means no transcript fetches, no API calls, no tokens spent.
// ---------------------------------------------------------------------------

function renderToggle(paused) {
  toggleInput.checked = !paused;
  toggleState.textContent = paused ? "Paused" : "On";
  toggleInput.closest(".switch").title = paused
    ? "Scoring is paused - no tokens are being spent. Click to resume."
    : "Scoring is on. Click to pause and stop spending tokens.";
}

toggleInput.addEventListener("change", async () => {
  const paused = !toggleInput.checked;
  await chrome.storage.local.set({ paused });
  renderToggle(paused);
  setStatus(paused ? "Paused - not spending tokens." : "Resumed.", false);
});

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

chrome.storage.local.get(
  ["settings", "apiKey", "paused"],
  ({ settings: s, apiKey, paused }) => {
    if (s && s.provider) {
      settings = { configs: {}, ...s };
    } else if (apiKey) {
      // Migrate pre-provider installs, where the Anthropic key was stored bare.
      settings = { provider: "anthropic", configs: { anthropic: { apiKey } } };
      chrome.storage.local.set({ settings });
    }
    renderForm();
    renderToggle(Boolean(paused));
  }
);

const keyInput = document.getElementById("key");
const serverInput = document.getElementById("server");
const saveBtn = document.getElementById("save");
const status = document.getElementById("status");

function setStatus(msg, isErr) {
  status.textContent = msg;
  status.className = "status " + (isErr ? "err" : "ok");
}

chrome.storage.local.get(["apiKey", "serverUrl"], ({ apiKey, serverUrl }) => {
  if (apiKey) keyInput.value = apiKey;
  if (serverUrl) serverInput.value = serverUrl;
});

function normalizeUrl(raw) {
  let s = (raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return u.origin;
  } catch {
    return null;
  }
}

saveBtn.addEventListener("click", async () => {
  const apiKey = keyInput.value.trim();
  const serverUrl = normalizeUrl(serverInput.value);

  if (serverInput.value.trim() && serverUrl === null) {
    setStatus("Invalid server URL.", true);
    return;
  }

  if (serverUrl) {
    const granted = await chrome.permissions.request({
      origins: [serverUrl + "/*"],
    });
    if (!granted) {
      setStatus("Permission for that server was denied.", true);
      return;
    }
  }

  await chrome.storage.local.set({ apiKey, serverUrl });
  setStatus("Saved. Reload youtube.com.", false);
  setTimeout(() => setStatus("", false), 3000);
});

// Keep keys in sync with background/content scripts
const MODE_INPUTS = Array.from(document.querySelectorAll('input[name="mode"]'));
const apiEl = document.getElementById("apiUrl");
const saveBtn = document.getElementById("saveBtn");
const toast = document.getElementById("savedToast");

function showToast() {
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1500);
}

async function load() {
  const defaults = { mode: "medium", apiBaseUrl: "http://localhost:3000" };
  let stored = {};
  try {
    stored = await chrome.storage.local.get(["mode", "apiBaseUrl"]);
  } catch {}
  const mode = stored.mode || defaults.mode;
  const api = stored.apiBaseUrl || defaults.apiBaseUrl;

  MODE_INPUTS.forEach(r => (r.checked = r.value === mode));
  apiEl.value = api;
}

async function save() {
  const selected = MODE_INPUTS.find(r => r.checked)?.value || "medium";
  const apiBaseUrl = apiEl.value.trim() || "http://localhost:3000";

  saveBtn.classList.add("saving");
  try {
    await chrome.storage.local.set({ mode: selected, apiBaseUrl });
    showToast();
  } catch (e) {
    console.error("[popup] save error:", e);
    alert("Could not save settings. See console for details.");
  } finally {
    saveBtn.classList.remove("saving");
  }
}

saveBtn.addEventListener("click", save);
document.addEventListener("DOMContentLoaded", load);

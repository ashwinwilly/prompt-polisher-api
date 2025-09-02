// popup.js — save mode only
const MODE_INPUTS = Array.from(document.querySelectorAll('input[name="mode"]'));
const saveBtn = document.getElementById("saveBtn");
const toast = document.getElementById("savedToast");

function showToast() {
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1500);
}

async function load() {
  const defaults = { mode: "medium" };
  let stored = {};
  try {
    stored = await chrome.storage.local.get(["mode"]);
  } catch {}
  const mode = stored.mode || defaults.mode;
  MODE_INPUTS.forEach(r => (r.checked = r.value === mode));
}

async function save() {
  const selected = MODE_INPUTS.find(r => r.checked)?.value || "medium";
  saveBtn.classList.add("saving");
  try {
    await chrome.storage.local.set({ mode: selected });
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

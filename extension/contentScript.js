// contentScript.js — DEBUG MESSAGING

const TAG = "[PP_CS]";
const log = (...a) => console.log(TAG, ...a);

function toast(msg) {
  try {
    let h = document.getElementById("__pp_toast_host__");
    if (!h) {
      h = document.createElement("div");
      h.id = "__pp_toast_host__";
      h.style.position = "fixed";
      h.style.zIndex = "2147483647";
      h.style.bottom = "20px";
      h.style.right = "20px";
      h.attachShadow({ mode: "open" });
      const s = document.createElement("style");
      s.textContent = `.t{font:12px ui-sans-serif,system-ui;background:rgba(17,17,17,.92);color:#fff;padding:8px 10px;border-radius:10px;margin-top:8px}`;
      const root = document.createElement("div"); root.id = "root";
      h.shadowRoot.append(s, root);
      document.documentElement.appendChild(h);
    }
    const root = h.shadowRoot.getElementById("root");
    const el = document.createElement("div");
    el.className = "t"; el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  } catch {}
}

function editable() {
  const el = document.querySelector("form [contenteditable='true']") ||
             document.querySelector("form textarea") ||
             document.querySelector("[contenteditable='true']") ||
             document.querySelector("textarea");
  log("editable:", el);
  return el;
}
function getText(el) {
  if (!el) return "";
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value;
  if (el.isContentEditable) return el.innerText.replace(/\u00A0/g, " ").trimEnd();
  return "";
}

/* ===== FIX #2: Harden setText + wait before sending so NEW text is submitted ===== */
function setText(el, txt) {
  if (!el) return;
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    el.value = txt;
    try {
      // Give React-style editors multiple signals
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: txt, inputType: "insertText" }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {}
  } else if (el.isContentEditable) {
    el.textContent = txt; // simplest reliable write
    try {
      el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste" }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertFromPaste" }));
    } catch {}
  }
}
// wait two RAFs so the editor reconciles before sending
function afterEditorSettles() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function sendBtn() {
  const f = document.querySelector("form") || document.body;
  return f.querySelector("button[aria-label*='Send' i]") ||
         f.querySelector("button[type='submit']") ||
         f.querySelector("[data-testid='send-button']");
}
function clickSend() {
  const b = sendBtn();
  if (b) { b.click(); return true; }
  const el = editable();
  if (el && el.isConnected) {
    try { el.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", code:"Enter", bubbles:true })); return true; } catch {}
  }
  return false;
}

/* Replace editor text, wait a tick, then press Send */
let __ppSending = false;
async function replaceThenSend(improved) {
  if (__ppSending) return;
  __ppSending = true;
  try {
    const el = editable();
    if (!el) { toast("No input box"); return; }
    setText(el, improved);

    // allow frameworks to ingest the new value
    await afterEditorSettles();

    // optional: update any shadow/hidden mirror textarea ChatGPT keeps
    const mirror = document.querySelector('textarea[aria-label], textarea:not([disabled])');
    if (mirror && mirror !== el && mirror.value !== improved) {
      mirror.value = improved;
      try { mirror.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
    }

    clickSend();
  } finally {
    __ppSending = false;
  }
}
// Replace editor text, wait a tick — but DO NOT send
async function replaceOnly(improved) {
  const el = editable();
  if (!el) { toast("No input box"); return; }
  setText(el, improved);
  await afterEditorSettles();

  // Optional: update any mirrored textarea ChatGPT keeps
  const mirror = document.querySelector('textarea[aria-label], textarea:not([disabled])');
  if (mirror && mirror !== el && mirror.value !== improved) {
    mirror.value = improved;
    try { mirror.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
  }
}

// --- messaging helpers (unchanged)
function sendMessageCb(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
        if (err) log("sendMessage callback lastError:", err);
        resolve({ resp, err });
      });
    } catch (e) {
      log("sendMessage threw:", e);
      resolve({ resp: null, err: String(e) });
    }
  });
}

async function doRewrite() {
  toast("polishing…");
  const el = editable();
  if (!el) { toast("No input box"); return; }
  const raw = getText(el);
  if (!raw.trim()) { toast("Type something first"); return; }

  let mode = "medium";
  try { const cfg = await chrome.storage.local.get("mode"); if (cfg?.mode) mode = cfg.mode; } catch {}

  log("sending REWRITE via promise");
  let res = null, errP = null;
  try {
    res = await chrome.runtime.sendMessage({ type:"REWRITE", prompt: raw, mode });
  } catch (e) {
    errP = e;
    log("promise sendMessage error:", e);
  }
  log("promise response:", res);

  if (!res) {
    log("trying callback API");
    const { resp, err } = await sendMessageCb({ type:"REWRITE", prompt: raw, mode });
    log("callback response:", resp, "callback lastError:", err);
    res = resp;
  }

  if (!res || !res.ok || !res.improved) {
    if (res?.timeout) toast("⏱ timeout");
    else toast("⚠️ failed (see console / service worker)");
    return;
  }

  // ---- use the improved text, then send (FIX #2 applied here) ----
await replaceOnly((res.improved || "").trim());
toast("✨ polished — press Enter to send");

}

// --- simple trigger: Alt+P (unchanged)
document.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    doRewrite();
  }
}, true);

// --- startup logs + background ping (unchanged)
log("content script loaded", location.href);
try {
  chrome.runtime.sendMessage({ type:"PING" }, (resp) => {
    const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
    log("PING resp:", resp, "lastError:", err);
  });
} catch (e) {
  log("PING threw:", e);
  toast("Extension reloaded — refresh tab.");
}

/* ===== FIX #1: Always-visible floating “Polish” button (no other changes) ===== */
(function ensureFloatingPolish() {
  let host, root, btn;
  function ensureButton() {
    if (host?.isConnected) return;

    host = document.createElement("div");
    host.id = "__pp_float_host__";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "auto"; // allow events on host
    host.attachShadow({ mode: "open" });

    const css = document.createElement("style");
    css.textContent = `
      .wrap{position:fixed;pointer-events:none}
      button{
        pointer-events:auto;
        padding:6px 10px;border-radius:999px;border:1px solid #4445;
        background:#1f2937;color:#fff;font:12.5px ui-sans-serif,system-ui;cursor:pointer;
        box-shadow:0 4px 12px rgba(0,0,0,.25)
      }
      button:hover{filter:brightness(1.08)}
    `;

    root = document.createElement("div");
    root.className = "wrap";

    btn = document.createElement("button");
    btn.textContent = "Polish";
    btn.title = "Rewrite this prompt before sending";

// Don't kill our own click! Only suppress down/up phases.
const kill = (e) => { e.preventDefault(); e.stopPropagation(); /* no stopImmediatePropagation here */ };
["pointerdown","mousedown","mouseup"].forEach(evt => btn.addEventListener(evt, kill, true));

// Let the click go to our handler (still in capture so the page can't swallow it)
btn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  console.log("[PP_CS] POLISH BUTTON CLICK");
  doRewrite();
}, true);


    root.appendChild(btn);
    host.shadowRoot.append(css, root);
    document.documentElement.appendChild(host);
  }

  function positionButton() {
    ensureButton();
    const send = (function findSend() {
      const f = document.querySelector("form") || document.body;
      return f.querySelector("button[aria-label*='Send' i]") ||
             f.querySelector("button[type='submit']") ||
             f.querySelector("[data-testid='send-button']");
    })();

    if (send) {
      const r = send.getBoundingClientRect();
      const x = Math.max(8, r.left - 84);
      const y = r.top + (r.height - 28) / 2;
      root.style.left = `${Math.round(x)}px`;
      root.style.top  = `${Math.round(y)}px`;
      root.style.right = "";
      root.style.bottom = "";
    } else {
      // Fallback: bottom-right
      root.style.left = "";
      root.style.top  = "";
      root.style.right = "20px";
      root.style.bottom = "60px";
    }
  }

  ensureButton();
  positionButton();
  window.addEventListener("resize", positionButton, { passive: true });
  window.addEventListener("scroll", positionButton, { passive: true });
  new MutationObserver(positionButton).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();

// OPTIONAL: temporary visible button (kept exactly as-is)
(function injectTempButton(){
  const btn = document.createElement("button");
  btn.textContent = "Polish (diag)";
  Object.assign(btn.style, {
    position: "fixed", zIndex: 2147483647, right: "20px", bottom: "60px",
    padding: "6px 10px", borderRadius: "10px", border: "1px solid #4445",
    background: "#1f2937", color: "#fff", cursor: "pointer"
  });
  btn.addEventListener("click", () => doRewrite(), { capture: true });
  document.documentElement.appendChild(btn);
})();

// background.js — DEBUG

const TAG = "[PP_BG]";
const DEFAULTS = {
  apiBaseUrl: "    prompt-polisher-api.vercel.app/api/rewrite",
  mode: "medium",
  budgets: { fast: 3000, medium: 7000, slow: 12000 }
};

function now() { return new Date().toISOString().slice(11,19); }

async function getSettings() {
  try {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...stored };
  } catch (e) {
    console.log(now(), TAG, "getSettings error:", e);
    return { ...DEFAULTS };
  }
}

async function fetchWithTimeout(url, body, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("PP_TIMEOUT")), ms);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e && (e.message === "PP_TIMEOUT" || e.name === "AbortError");
    const err = isTimeout ? "PP_TIMEOUT" : String(e);
    return { ok: false, status: 0, _pp_error: err, _pp_timeout: isTimeout, text: async () => err };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const settings = await getSettings();
    if (!msg || !msg.type) { sendResponse({ ok:false, error:"no_message_type" }); return; }

    if (msg.type === "PING") {
      console.log(now(), TAG, "PING from", sender?.tab?.id, sender?.url);
      sendResponse({ ok:true, settings });
      return;
    }

    if (msg.type === "REWRITE") {
      const prompt = msg.prompt ?? "";
      const mode = msg.mode || settings.mode || "medium";
      const budgetMs = settings.budgets?.[mode] ?? settings.budgets.medium;
      const url = new URL("/api/rewrite", settings.apiBaseUrl).toString();

      console.log(now(), TAG, "REWRITE start", { mode, budgetMs, url, promptLen: prompt.length });

      if (!prompt.trim()) { sendResponse({ ok:false, error:"empty_prompt" }); return; }

      const t0 = Date.now();
      const res = await fetchWithTimeout(url, { prompt, mode }, budgetMs);
      const elapsed = Date.now() - t0;

      if (!res.ok) {
        const body = await (res.text?.() || Promise.resolve(String(res._pp_error || "")));
        console.log(now(), TAG, `HTTP ${res.status} in ${elapsed}ms`, body);
        sendResponse({ ok:false, error: body || `HTTP ${res.status}`, timeout: !!res._pp_timeout });
        return;
      }

      let json = null;
      try { json = await res.json(); }
      catch (e) {
        console.log(now(), TAG, "JSON parse error:", e);
        sendResponse({ ok:false, error:"bad_json" });
        return;
      }

      console.log(now(), TAG, "REWRITE ok in", elapsed, "ms", json?.meta);
      sendResponse({ ok:true, improved: json?.improved || "", meta: json?.meta });
    }
  })();

  return true; // keep the message channel open
});

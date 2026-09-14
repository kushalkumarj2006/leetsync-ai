/* ============================================================
   LeetSync AI — Offscreen Document
   Hosts WASM PoW worker + proxies DeepSeek chat completions
   ============================================================ */

const DEEPSEEK_HOST = "https://chat.deepseek.com";
const CLIENT_HEADERS = {
  "X-Client-Platform": "web",
  "X-Client-Version": "2.3.0",
  "X-Client-Bundle-Id": "com.deepseek.chat",
  "X-Client-Locale": "en_US"
};

/* ---------------- PoW worker ---------------- */

let powWorker = null;
let powReady = null;

function initPowWorker() {
  if (powReady) return powReady;
  powReady = (async () => {
    const workerUrl = chrome.runtime.getURL("offscreen/pow/worker.js");
    const wasmUrl = chrome.runtime.getURL("offscreen/pow/sha3.wasm");

    const script = await fetch(workerUrl).then(r => r.text());

    // Patch WASM path — the bundle has:
    //   57981(e,t,r){e.exports=r.p+"static/sha3_wasm_bg.7b9ca65ddd.wasm"}
    const patched = script
      .replace(/r\.p\s*\+\s*"static\/sha3_wasm_bg\.7b9ca65ddd\.wasm"/g, JSON.stringify(wasmUrl))
      .replace(/r\.p\s*\+\s*'static\/sha3_wasm_bg\.7b9ca65ddd\.wasm'/g, JSON.stringify(wasmUrl));

    const blob = new Blob([patched], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    powWorker = new Worker(blobUrl);
    return powWorker;
  })();
  return powReady;
}

function solvePoW(challenge) {
  return new Promise(async (resolve, reject) => {
    try {
      const w = await initPowWorker();
      const handler = (e) => {
        const msg = e.data;
        if (msg.type === "pow-answer") {
          w.removeEventListener("message", handler);
          resolve(msg.answer);
        } else if (msg.type === "pow-error") {
          w.removeEventListener("message", handler);
          reject(new Error(String(msg.error)));
        }
      };
      w.addEventListener("message", handler);
      w.postMessage({ type: "pow-challenge", challenge });
      setTimeout(() => reject(new Error("PoW timeout")), 30000);
    } catch (e) { reject(e); }
  });
}

/* ---------------- DeepSeek HTTP ---------------- */

function proxyUrl(backendBase, path) {
  const base = (backendBase || "").replace(/\/+$/, "") + "/";
  return base + DEEPSEEK_HOST + path;
}

async function dsFetch(backendBase, path, options = {}, smidV2) {
  const url = proxyUrl(backendBase, path);
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (smidV2) headers["Cookie"] = `smidV2=${smidV2}`;
  return await fetch(url, { ...options, headers });
}

async function deepseekComplete({ prompt, userToken, smidV2, backendBase, searchEnabled }) {
  if (!userToken) return { ok: false, error: "Missing userToken" };
  if (!backendBase) return { ok: false, error: "Missing backendBase" };

  const auth = { Authorization: `Bearer ${userToken}` };
  const client = {
    ...CLIENT_HEADERS,
    "X-Client-Timezone-Offset": String(-new Date().getTimezoneOffset())
  };

  // 1. Create session
  let sessionId;
  {
    const res = await dsFetch(backendBase, "/api/v0/chat_session/create", {
      method: "POST", headers: { ...auth, ...client }, body: JSON.stringify({})
    }, smidV2);
    if (!res.ok) return { ok: false, error: `Session ${res.status}` };
    const j = await res.json();
    sessionId = j?.data?.biz_data?.chat_session?.id;
    if (!sessionId) return { ok: false, error: "No session id: " + JSON.stringify(j).slice(0, 200) };
  }

  // 2. PoW challenge
  const targetPath = "/api/v0/chat/completion";
  let challenge;
  {
    const res = await dsFetch(backendBase, "/api/v0/chat/create_pow_challenge", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ target_path: targetPath })
    }, smidV2);
    if (!res.ok) return { ok: false, error: `PoW challenge ${res.status}` };
    const j = await res.json();
    if (j.code !== 0) return { ok: false, error: `PoW code ${j.code}: ${j.msg || ""}` };
    challenge = j.data.biz_data.challenge;
  }

  // 3. Solve PoW
  let answer;
  try {
    answer = await solvePoW({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      difficulty: challenge.difficulty,
      signature: challenge.signature,
      expireAt: challenge.expire_at
    });
  } catch (e) {
    return { ok: false, error: "PoW: " + e.message };
  }

  const powHeader = btoa(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer: answer.answer,
    signature: challenge.signature,
    target_path: targetPath
  }));

  // 4. Completion request
  const completionRes = await dsFetch(backendBase, "/api/v0/chat/completion", {
    method: "POST",
    headers: { ...auth, ...client, "X-Ds-Pow-Response": powHeader },
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: !!searchEnabled,
      action: null,
      preempt: false
    })
  }, smidV2);

  if (!completionRes.ok) {
    const err = await completionRes.text();
    return { ok: false, error: `Completion ${completionRes.status}: ${err.slice(0, 200)}` };
  }

  // 5. Parse SSE
  const reader = completionRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]" || data === "") continue;

      let j;
      try { j = JSON.parse(data); } catch { continue; }

      let delta = null;
      if (j.type === "response.output_text.delta" && j.delta) delta = j.delta;
      else if (j.p === "response/fragments/-1/content" && j.o === "APPEND") delta = j.v;
      else if (j.v && typeof j.v === "string" && !j.p) delta = j.v;

      if (delta) text += delta;
    }
  }

  return { ok: true, text: text.trim() };
}

/* ---------------- Message router ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  (async () => {
    try {
      if (msg.type === "PING") {
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "DEEPSEEK_COMPLETE") {
        const res = await deepseekComplete(msg);
        sendResponse(res);
        return;
      }
      sendResponse({ ok: false, error: "Unknown offscreen message: " + msg.type });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});

initPowWorker().catch(e => console.warn("[offscreen] Worker warmup failed:", e));
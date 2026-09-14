/* ============================================================
   LeetSync AI — Content Script (LeetCode problem pages)
   ============================================================ */
(() => {
  if (window.__leetsyncInjected) return;
  window.__leetsyncInjected = true;
  let submissionInProgress = false;
  let lastSeenResultText = null;
  let currentSlug = null;
  let currentMeta = null;
  const metaCache = {};
  /* ---------------- Utils ---------------- */
  const slugFromUrl = () => {
    const m = location.pathname.match(/problems\/([^/]+)/);
    return m ? m[1] : null;
  };
  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false });
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }
  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function toast(text, ok = true) {
    const el = document.createElement("div");
    el.textContent = (ok ? "✅ " : "⚠️ ") + text;
    Object.assign(el.style, {
      position: "fixed", bottom: "24px", left: "50%",
      transform: "translateX(-50%)", zIndex: "2147483647",
      background: ok ? "#0f9d58" : "#d93025", color: "#fff",
      padding: "10px 18px", borderRadius: "8px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "13px", fontWeight: "600",
      boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
      opacity: "0", transition: "opacity 0.2s ease"
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => el.style.opacity = "1");
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 250);
    }, 2600);
  }
  /* ---------------- Problem metadata ---------------- */
  async function fetchMeta(slug) {
    if (metaCache[slug]) return metaCache[slug];
    const query = `
      query q($titleSlug: String!) {
        question(titleSlug: $titleSlug) {
          questionFrontendId
          title
          titleSlug
          difficulty
          content
          topicTags { name slug }
        }
      }`;
    try {
      const res = await fetch("https://leetcode.com/graphql/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { titleSlug: slug } })
      });
      const j = await res.json();
      const q = j?.data?.question;
      if (!q) return null;
      const meta = {
        number: parseInt(q.questionFrontendId, 10) || 0,
        title: q.title,
        slug: q.titleSlug,
        difficulty: q.difficulty,
        description: stripHtml(q.content || ""),
        topics: (q.topicTags || []).map(t => t.name)
      };
      metaCache[slug] = meta;
      return meta;
    } catch (e) {
      console.warn("[LeetSync] Meta fetch failed:", e);
      return null;
    }
  }
  function stripHtml(html) {
    const d = document.createElement("div");
    d.innerHTML = html;
    return (d.textContent || "").replace(/\s+\n/g, "\n").trim();
  }
  async function getCurrentMeta() {
    const slug = slugFromUrl();
    if (!slug) return null;
    if (currentMeta && currentMeta.slug === slug) return currentMeta;
    currentMeta = await fetchMeta(slug);
    return currentMeta;
  }
  /* ---------------- Accepted detection ---------------- */
  function onAttemptStart() {
    submissionInProgress = true;
    const el = document.querySelector('[data-e2e-locator="submission-result"]');
    lastSeenResultText = el ? (el.innerText || "").trim() : null;
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-e2e-locator="console-submit-button"]')) onAttemptStart();
  }, true);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onAttemptStart();
  }, true);
  const observer = new MutationObserver(async () => {
    if (!submissionInProgress) return;
    const el = document.querySelector('[data-e2e-locator="submission-result"]');
    if (!el) return;
    const status = (el.innerText || "").trim();
    // Ignore the stale "Accepted" left over from the previous submission.
    if (status === lastSeenResultText) return;
    // Remember intermediate states (Pending, Wrong Answer, etc.) so we don't loop on them.
    if (!/^accepted$/i.test(status)) {
      lastSeenResultText = status;
      return;
    }
    // Real accepted transition. Process it.
    lastSeenResultText = status;
    submissionInProgress = false;
    const slug = slugFromUrl();
    if (!slug) return;
    const meta = await fetchMeta(slug);
    const codeInfo = await send("EXTRACT_CODE_REQUEST", { slug });
    if (!codeInfo || !codeInfo.code) {
      toast("Could not read code from editor.", false);
      return;
    }
    toast("Syncing to GitHub…");
    const result = await send("SUBMISSION_ACCEPTED", {
      slug,
      language: codeInfo.language,
      code: codeInfo.code,
      meta: meta || {
        number: 0, title: slug.replace(/-/g, " "),
        slug, difficulty: "Unknown", description: "", topics: []
      }
    });
    if (result?.ok) {
      if (result.skipped) toast("Saved locally (auto-sync off).");
      else toast("Synced: " + (result.path || slug));
    } else {
      toast("Sync failed: " + (result?.error || "unknown"), false);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => {
    const s = slugFromUrl();
    if (s && s !== currentSlug) {
      currentSlug = s;
      currentMeta = null;
      submissionInProgress = false;
      lastSeenResultText = null;
    }
  }, 800);
  /* ---------------- Panel ---------------- */
  const BTN_ID = "leetsync-ai-btn";
  const PANEL_ID = "leetsync-ai-panel";
  const PLAYER_ID = "leetsync-player";
  const STYLE_ID = "leetsync-ai-styles";
  const activeTab = { current: "hint" };
  const tabContent = { hint: null, compare: null, slow: null, videos: null };
  const CSS = `
    #${BTN_ID} {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg,#7c3aed,#2563eb);
      color: #fff; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 8px 24px rgba(59,130,246,0.35);
      font-family: system-ui, sans-serif; font-size: 22px;
      transition: transform 0.15s ease;
    }
    #${BTN_ID}:hover { transform: scale(1.06); }
    #${PANEL_ID} {
      position: fixed; right: 20px; bottom: 84px; z-index: 2147483645;
      width: 400px; max-height: 620px; background: #ffffff;
      border-radius: 14px; box-shadow: 0 16px 48px rgba(0,0,0,0.22);
      border: 1px solid #e5e7eb; display: flex; flex-direction: column;
      font-family: system-ui, -apple-system, sans-serif; color: #111827;
      overflow: hidden;
    }
    #${PANEL_ID} .ls-header {
      padding: 12px 14px;
      background: linear-gradient(135deg,#7c3aed,#2563eb);
      color: #fff; font-weight: 600; font-size: 13.5px;
      display: flex; align-items: center; justify-content: space-between;
    }
    #${PANEL_ID} .ls-header button {
      background: transparent; border: none; color: #fff;
      font-size: 16px; cursor: pointer; padding: 0 4px;
    }
    #${PANEL_ID} .ls-tabs {
      display: flex; border-bottom: 1px solid #e5e7eb;
      background: #f9fafb;
    }
    #${PANEL_ID} .ls-tab {
      flex: 1; padding: 9px 6px; border: none; background: transparent;
      cursor: pointer; font-size: 12px; font-weight: 600;
      color: #6b7280; border-bottom: 2px solid transparent;
      transition: color .15s ease, border-color .15s ease;
    }
    #${PANEL_ID} .ls-tab:hover { color: #111827; }
    #${PANEL_ID} .ls-tab.active {
      color: #2563eb; border-bottom-color: #2563eb; background: #fff;
    }
    #${PANEL_ID} .ls-body {
      flex: 1; overflow-y: auto; padding: 12px 14px;
      font-size: 13px; line-height: 1.55; min-height: 120px;
      max-height: 440px;
    }
    #${PANEL_ID} .ls-body pre {
      white-space: pre-wrap; word-break: break-word;
      font-family: inherit; margin: 0;
    }
    #${PANEL_ID} .ls-empty { color: #6b7280; font-style: italic; }
    #${PANEL_ID} .ls-loading {
      color: #2563eb; font-style: italic;
      display: flex; align-items: center; gap: 8px;
    }
    #${PANEL_ID} .ls-spinner {
      width: 14px; height: 14px; border: 2px solid #dbeafe;
      border-top-color: #2563eb; border-radius: 50%;
      animation: lsSpin 0.8s linear infinite;
    }
    @keyframes lsSpin { to { transform: rotate(360deg); } }
    #${PANEL_ID} .ls-footer {
      border-top: 1px solid #e5e7eb; padding: 10px 12px;
      display: flex; gap: 8px; background: #f9fafb;
    }
    #${PANEL_ID} .ls-footer button {
      flex: 1; padding: 9px 12px; border-radius: 8px; border: none;
      font-weight: 600; font-size: 12.5px; cursor: pointer;
      transition: filter .15s ease;
    }
    #${PANEL_ID} .ls-footer button:hover { filter: brightness(0.95); }
    #${PANEL_ID} .ls-primary { background: #2563eb; color: #fff; }
    #${PANEL_ID} .ls-secondary { background: #e5e7eb; color: #111827; }
    #${PANEL_ID} .ls-footer.hidden { display: none; }
    /* Video cards */
    .ls-video {
      display: flex; gap: 10px; padding: 6px 0;
      border-bottom: 1px solid #f3f4f6;
    }
    .ls-video:last-child { border-bottom: none; }
    .ls-thumb {
      flex-shrink: 0; width: 132px; height: 74px;
      background-size: cover; background-position: center;
      background-color: #111827; border-radius: 6px;
      position: relative; cursor: pointer; overflow: hidden;
    }
    .ls-thumb:hover .ls-play { background: #dc2626; }
    .ls-play {
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 34px; height: 34px; border-radius: 50%;
      background: rgba(220, 38, 38, 0.85); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; transition: background .15s ease;
    }
    .ls-dur {
      position: absolute; bottom: 4px; right: 4px;
      background: rgba(0,0,0,0.85); color: #fff;
      padding: 1px 5px; border-radius: 3px;
      font-size: 10.5px; font-weight: 600;
    }
    .ls-vmeta { flex: 1; min-width: 0; }
    .ls-vtitle {
      font-size: 12px; font-weight: 600; line-height: 1.3;
      display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow: hidden;
      color: #111827;
    }
    .ls-vsub {
      font-size: 11px; color: #6b7280; margin-top: 3px;
      display: -webkit-box; -webkit-line-clamp: 1;
      -webkit-box-orient: vertical; overflow: hidden;
    }
    .ls-vstats {
      font-size: 11px; color: #6b7280; margin-top: 3px;
      display: flex; gap: 6px; flex-wrap: wrap;
    }
    /* Draggable player */
    #${PLAYER_ID} {
      position: fixed; z-index: 2147483647;
      width: 480px; max-width: calc(100vw - 20px);
      background: #0f172a; border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      overflow: hidden; user-select: none;
      border: 1px solid rgba(255,255,255,0.08);
    }
    #${PLAYER_ID} .ls-player-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; background: #1e293b; color: #f1f5f9;
      font-family: system-ui, sans-serif; font-size: 12.5px;
      font-weight: 600;
    }
    #${PLAYER_ID} .ls-player-title {
      flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      margin-right: 10px;
    }
    #${PLAYER_ID} .ls-player-actions {
      display: flex; gap: 4px; flex-shrink: 0;
    }
    #${PLAYER_ID} .ls-player-btn {
      background: rgba(255,255,255,0.08); color: #f1f5f9;
      border: none; width: 22px; height: 22px;
      border-radius: 5px; cursor: pointer;
      font-size: 13px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      transition: background .15s ease;
    }
    #${PLAYER_ID} .ls-player-btn:hover { background: rgba(255,255,255,0.2); }
    #${PLAYER_ID} .ls-player-body {
      width: 100%; aspect-ratio: 16/9; background: #000;
    }
    #${PLAYER_ID} iframe { width: 100%; height: 100%; display: block; border: 0; }
    /* Dark mode */
    html.dark #${PANEL_ID} { background: #1f2937; color: #f3f4f6; border-color: #374151; }
    html.dark #${PANEL_ID} .ls-tabs { background: #111827; border-color: #374151; }
    html.dark #${PANEL_ID} .ls-tab { color: #9ca3af; }
    html.dark #${PANEL_ID} .ls-tab.active { color: #60a5fa; border-color: #60a5fa; background: #1f2937; }
    html.dark #${PANEL_ID} .ls-footer { background: #111827; border-color: #374151; }
    html.dark #${PANEL_ID} .ls-secondary { background: #374151; color: #f3f4f6; }
    html.dark #${PANEL_ID} .ls-empty { color: #9ca3af; }
    html.dark .ls-vtitle { color: #f3f4f6; }
    html.dark .ls-video { border-color: #374151; }
    html.dark .ls-vstats { color: #9ca3af; }
    html.dark .ls-vsub { color: #9ca3af; }
  `;
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  function buildButton() {
    if (document.getElementById(BTN_ID)) return;
    ensureStyles();
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.title = "LeetSync AI";
    btn.textContent = "✨";
    btn.addEventListener("click", togglePanel);
    document.body.appendChild(btn);
  }
  function togglePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }
    buildPanel();
  }
  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="ls-header">
        <span>✨ LeetSync AI</span>
        <button id="ls-close" title="Close">✕</button>
      </div>
      <div class="ls-tabs">
        <button class="ls-tab active" data-tab="hint">✨ Hint</button>
        <button class="ls-tab" data-tab="compare">⚡ Compare</button>
        <button class="ls-tab" data-tab="slow">🐌 Slow?</button>
        <button class="ls-tab" data-tab="videos">▶ Videos</button>
      </div>
      <div class="ls-body" id="ls-body"></div>
      <div class="ls-footer" id="ls-footer">
        <button class="ls-primary" id="ls-action">Get Hint</button>
        <button class="ls-secondary" id="ls-clear">Clear</button>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector("#ls-close").addEventListener("click", () => panel.remove());
    panel.querySelectorAll(".ls-tab").forEach(tab => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });
    panel.querySelector("#ls-action").addEventListener("click", onActionClick);
    panel.querySelector("#ls-clear").addEventListener("click", clearCurrent);
    switchTab("hint");
  }
  function switchTab(name) {
    activeTab.current = name;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.querySelectorAll(".ls-tab").forEach(t =>
      t.classList.toggle("active", t.dataset.tab === name)
    );
    const actionBtn = panel.querySelector("#ls-action");
    const footer = panel.querySelector("#ls-footer");
    if (name === "videos") {
      footer.classList.add("hidden");
      if (!tabContent.videos) loadVideos();
      else renderBody(tabContent.videos);
      return;
    }
    footer.classList.remove("hidden");
    if (name === "hint") actionBtn.textContent = "Get Hint";
    if (name === "compare") actionBtn.textContent = "Compare to Optimal";
    if (name === "slow") actionBtn.textContent = "Why Is It Slow?";
    renderBody(tabContent[name]);
  }
  function renderBody(html) {
    const body = document.getElementById("ls-body");
    if (!body) return;
    if (!html) {
      const empty = {
        hint: "Ask for a short hint about your current solution.",
        compare: "Ask the AI to compare your solution to the optimal approach.",
        slow: "Ask why your accepted solution has a low runtime/memory percentile.",
        videos: "Loading videos…"
      }[activeTab.current];
      body.innerHTML = `<div class="ls-empty">${empty}</div>`;
      return;
    }
    body.innerHTML = html;
  }
  function clearCurrent() {
    tabContent[activeTab.current] = null;
    if (activeTab.current === "videos") {
      tabContent.videos = null;
      loadVideos();
      return;
    }
    renderBody(null);
  }
  function setLoading(text) {
    const body = document.getElementById("ls-body");
    if (body) body.innerHTML = `<div class="ls-loading"><div class="ls-spinner"></div>${esc(text)}</div>`;
  }
  function setError(text) {
    const body = document.getElementById("ls-body");
    if (body) body.innerHTML = `<div style="color:#dc2626;">⚠️ ${esc(text)}</div>`;
  }
  function setPre(text) {
    const body = document.getElementById("ls-body");
    if (body) body.innerHTML = `<pre>${esc(text)}</pre>`;
  }
  /* ---------------- AI Actions ---------------- */
  async function onActionClick() {
    const tab = activeTab.current;
    if (tab === "videos") return;
    const meta = await getCurrentMeta();
    if (!meta) { setError("Could not load problem info."); return; }
    const codeInfo = await send("EXTRACT_CODE_REQUEST", { slug: meta.slug });
    if (!codeInfo || !codeInfo.code) { setError("Could not read your code from the editor."); return; }
    const payload = {
      title: meta.title,
      difficulty: meta.difficulty,
      description: meta.description,
      code: codeInfo.code,
      language: codeInfo.language
    };
    const labels = {
      hint: "Thinking of a hint…",
      compare: "Comparing to optimal…",
      slow: "Analyzing performance…"
    };
    setLoading(labels[tab] || "Thinking…");
    const msgType = { hint: "AI_HINT", compare: "AI_COMPARE", slow: "AI_SLOW" }[tab];
    const res = await send(msgType, payload);
    if (!res || !res.ok) {
      setError("AI error: " + (res?.error || "unknown"));
      tabContent[tab] = `<div style="color:#dc2626;">⚠️ ${esc(res?.error || "unknown")}</div>`;
      return;
    }
    setPre(res.text || "(empty response)");
    tabContent[tab] = document.getElementById("ls-body").innerHTML;
  }
  /* ---------------- Videos ---------------- */
  async function loadVideos() {
    setLoading("Loading video solutions…");
    const meta = await getCurrentMeta();
    if (!meta) { setError("Could not load problem info."); return; }
    const res = await send("FETCH_VIDEOS", { number: meta.number, title: meta.title });
    if (!res || !res.ok) {
      const msg = res?.error || "unknown";
      setError("Video fetch failed: " + msg);
      tabContent.videos = `<div style="color:#dc2626;">⚠️ ${esc(msg)}</div>`;
      return;
    }
    if (!res.videos || !res.videos.length) {
      const html = `<div class="ls-empty">No videos found for this problem.</div>`;
      document.getElementById("ls-body").innerHTML = html;
      tabContent.videos = html;
      return;
    }
    renderVideos(res.videos);
  }
  function renderVideos(videos) {
    const body = document.getElementById("ls-body");
    if (!body) return;
    body.innerHTML = "";
    for (const v of videos) body.appendChild(videoCard(v));
    tabContent.videos = body.innerHTML;
  }
  function fmtViews(n) {
    if (!n) return "";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K views";
    return n + " views";
  }
  function fmtLikes(n) {
    if (!n) return "";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }
  function videoCard(v) {
    const wrap = document.createElement("div");
    wrap.className = "ls-video";
    const thumb = document.createElement("div");
    thumb.className = "ls-thumb";
    const thumbUrl = v.thumbnail || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
    thumb.style.backgroundImage = `url(${thumbUrl})`;
    if (v.duration) {
      const dur = document.createElement("span");
      dur.className = "ls-dur";
      dur.textContent = v.duration;
      thumb.appendChild(dur);
    }
    const play = document.createElement("div");
    play.className = "ls-play";
    play.textContent = "▶";
    thumb.appendChild(play);
    const meta = document.createElement("div");
    meta.className = "ls-vmeta";
    meta.innerHTML = `
      <div class="ls-vtitle">${esc(v.title)}</div>
      <div class="ls-vsub">${esc(v.channel)}</div>
      <div class="ls-vstats">
        ${v.views ? `<span>${esc(fmtViews(v.views))}</span>` : ""}
        ${v.likes ? `<span>👍 ${esc(fmtLikes(v.likes))}</span>` : ""}
      </div>
    `;
    thumb.addEventListener("click", () => openPlayer(v));
    wrap.appendChild(thumb);
    wrap.appendChild(meta);
    return wrap;
  }
  /* ---------------- Draggable player ---------------- */
  function openPlayer(video) {
    const existing = document.getElementById(PLAYER_ID);
    if (existing) existing.remove();
    const player = document.createElement("div");
    player.id = PLAYER_ID;
    player.innerHTML = `
      <div class="ls-player-header">
        <span class="ls-player-title">${esc(video.title)}</span>
        <div class="ls-player-actions">
          <button class="ls-player-btn" data-act="min" title="Minimize">—</button>
          <button class="ls-player-btn" data-act="close" title="Close">✕</button>
        </div>
      </div>
      <div class="ls-player-body">
        <iframe
          src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}?autoplay=1&modestbranding=1&rel=0&playsinline=1"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
          frameborder="0"
        ></iframe>
      </div>
    `;
    document.body.appendChild(player);
    const w = 480, h = 300;
    player.style.left = Math.max(20, (window.innerWidth - w) / 2) + "px";
    player.style.top = Math.max(20, (window.innerHeight - h) / 2) + "px";
    makeDraggable(player);
    player.querySelector('[data-act="close"]').addEventListener("click", () => player.remove());
    player.querySelector('[data-act="min"]').addEventListener("click", (e) => {
      const body = player.querySelector(".ls-player-body");
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      player.style.height = hidden ? "" : "auto";
      e.target.textContent = hidden ? "—" : "+";
    });
  }
  function makeDraggable(el) {
    const header = el.querySelector(".ls-player-header");
    let dragging = false;
    let offX = 0, offY = 0;
    header.style.cursor = "grab";
    const start = (clientX, clientY) => {
      const r = el.getBoundingClientRect();
      offX = clientX - r.left;
      offY = clientY - r.top;
      dragging = true;
      header.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    };
    const move = (clientX, clientY) => {
      if (!dragging) return;
      const maxX = window.innerWidth - el.offsetWidth;
      const maxY = window.innerHeight - el.offsetHeight;
      const x = Math.max(0, Math.min(maxX, clientX - offX));
      const y = Math.max(0, Math.min(maxY, clientY - offY));
      el.style.left = x + "px";
      el.style.top = y + "px";
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      header.style.cursor = "grab";
      document.body.style.userSelect = "";
    };
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      start(e.clientX, e.clientY);
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
    document.addEventListener("mouseup", end);
    header.addEventListener("touchstart", (e) => {
      if (e.target.closest("button")) return;
      const t = e.touches[0];
      start(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      move(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener("touchend", end);
  }
  /* ---------------- Boot & SPA nav ---------------- */
  function ensurePanelExists() {
    if (!/leetcode\.com\/problems\//.test(location.href)) {
      const b = document.getElementById(BTN_ID);
      const p = document.getElementById(PANEL_ID);
      const pl = document.getElementById(PLAYER_ID);
      if (b) b.remove();
      if (p) p.remove();
      if (pl) pl.remove();
      return;
    }
    if (!document.getElementById(BTN_ID)) buildButton();
  }
  if (document.body) ensurePanelExists();
  else document.addEventListener("DOMContentLoaded", ensurePanelExists);
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(ensurePanelExists, 400);
    }
  }, 500);
})();

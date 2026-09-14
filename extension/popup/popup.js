/* ============================================================
   LeetSync AI — Popup
   ============================================================ */

const $ = (id) => document.getElementById(id);

const screens = {
  welcome: $("screen-welcome"),
  setup: $("screen-setup"),
  dash: $("screen-dash")
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function send(type, payload) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false });
    });
  });
}

function fmtTime(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + " min ago";
  if (d < 86400) return Math.floor(d / 3600) + " hr ago";
  return Math.floor(d / 86400) + " days ago";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------------- Load state ---------------- */

async function load() {
  const cfg = await chrome.storage.local.get([
    "backendBase",
    "githubOwner", "githubRepo", "githubToken",
    "deepseekToken", "deepseekSmid",
    "autoSync", "aiEnabled",
    "stats", "history", "streak", "lastSync", "syncError", "lastAccepted"
  ]);

  $("backendBase").value = cfg.backendBase || "";
  $("ghOwner").value = cfg.githubOwner || "";
  $("ghRepo").value = cfg.githubRepo || "";
  $("ghToken").value = cfg.githubToken || "";
  $("dsToken").value = cfg.deepseekToken || "";
  $("dsSmid").value = cfg.deepseekSmid || "";

  const connected = cfg.githubOwner && cfg.githubRepo && cfg.githubToken && cfg.backendBase;

  if (!connected) {
    showScreen("welcome");
    return;
  }

  $("repoLabel").textContent = `${cfg.githubOwner}/${cfg.githubRepo}`;
  $("toggleAutoSync").checked = cfg.autoSync !== false;
  $("toggleAI").checked = !!cfg.aiEnabled;

  const stats = cfg.stats || { solved: 0, easy: 0, medium: 0, hard: 0 };
  $("statSolved").textContent = stats.solved || 0;
  $("statEasy").textContent = stats.easy || 0;
  $("statMedium").textContent = stats.medium || 0;
  $("statHard").textContent = stats.hard || 0;
  $("statStreak").textContent = cfg.streak || 0;

  const autoOn = cfg.autoSync !== false;
  $("manualSync").classList.toggle("hidden", autoOn);

  renderStatus(cfg);
  renderHistory(cfg.history || []);
  showScreen("dash");
}

function renderStatus(cfg) {
  const box = $("statusBox");
  box.className = "status";
  box.classList.add("hidden");
  box.textContent = "";

  if (cfg.syncError) {
    box.classList.remove("hidden");
    box.classList.add("err");
    box.textContent = "Sync error: " + cfg.syncError.message;
    return;
  }
  if (cfg.lastSync) {
    box.classList.remove("hidden");
    box.classList.add("success");
    box.textContent = `Last synced ${cfg.lastSync.path} • ${fmtTime(cfg.lastSync.time)}`;
    return;
  }
  if (cfg.autoSync === false && cfg.lastAccepted) {
    box.classList.remove("hidden");
    box.classList.add("warn");
    box.textContent = `Accepted but not synced: ${cfg.lastAccepted.path}`;
  }
}

function renderHistory(history) {
  const list = $("historyList");
  list.innerHTML = "";
  if (!history.length) {
    list.innerHTML = `<div class="muted small">No submissions yet.</div>`;
    return;
  }
  for (const h of history.slice(0, 30)) {
    const el = document.createElement("div");
    el.className = "item";
    const diffClass = ["Easy", "Medium", "Hard"].includes(h.difficulty) ? h.difficulty : "Unknown";
    el.innerHTML = `
      <div class="left">
        <div class="title">${escapeHtml(h.title || h.slug)}</div>
        <div class="sub">${escapeHtml(h.lang)} • ${fmtTime(h.time)}</div>
      </div>
      <span class="diff ${diffClass}">${diffClass}</span>
    `;
    list.appendChild(el);
  }
}

/* ---------------- Navigation ---------------- */

$("closeBtn").addEventListener("click", () => window.close());
$("startSetup").addEventListener("click", () => showScreen("setup"));
$("backToWelcome").addEventListener("click", () => showScreen("welcome"));
$("editCfg").addEventListener("click", () => showScreen("setup"));

/* ---------------- Backend ---------------- */

$("backendBase").addEventListener("input", async (e) => {
  const v = e.target.value.trim();
  await chrome.storage.local.set({ backendBase: v });
});

$("pingBackend").addEventListener("click", async () => {
  const el = $("backendStatus");
  const base = $("backendBase").value.trim();
  if (!base) {
    el.className = "status err";
    el.textContent = "Enter a backend URL first.";
    el.classList.remove("hidden");
    return;
  }
  el.className = "status";
  el.textContent = "Testing…";
  el.classList.remove("hidden");
  try {
    const res = await fetch(base.replace(/\/+$/, "") + "/health");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    el.className = "status success";
    el.textContent = "Backend OK ✓ " + (j.service || "");
  } catch (e) {
    el.className = "status err";
    el.textContent = "Backend unreachable: " + e.message;
  }
});

/* ---------------- GitHub ---------------- */

$("saveGithub").addEventListener("click", async () => {
  const owner = $("ghOwner").value.trim();
  const repo = $("ghRepo").value.trim();
  const token = $("ghToken").value.trim();
  const err = $("setupError");

  err.classList.add("hidden");
  if (!owner || !repo || !token) {
    err.textContent = "All three fields are required.";
    err.classList.remove("hidden");
    return;
  }

  const btn = $("saveGithub");
  btn.disabled = true;
  btn.textContent = "Verifying…";

  const res = await send("VERIFY_GITHUB", { owner, repo, token });

  btn.disabled = false;
  btn.textContent = "Connect Repository";

  if (!res || !res.success) {
    err.textContent = res?.error || "Verification failed.";
    err.classList.remove("hidden");
    return;
  }

  await chrome.storage.local.set({
    githubOwner: owner, githubRepo: repo, githubToken: token, autoSync: true
  });
  await load();
});

/* ---------------- DeepSeek ---------------- */

$("saveDS").addEventListener("click", async () => {
  const dsToken = $("dsToken").value.trim();
  const dsSmid = $("dsSmid").value.trim();
  await chrome.storage.local.set({ deepseekToken: dsToken, deepseekSmid: dsSmid });
  const el = $("dsStatus");
  el.textContent = "Saved.";
  el.className = "status success";
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 1500);
});

$("pingDS").addEventListener("click", async () => {
  const el = $("dsStatus");
  el.textContent = "Testing offscreen worker…";
  el.className = "status";
  el.classList.remove("hidden");
  const r = await send("DEEPSEEK_PING", {});
  if (r && r.ok) {
    el.textContent = "Offscreen worker is ready.";
    el.className = "status success";
  } else {
    el.textContent = "Offscreen not responding: " + (r?.error || "unknown");
    el.className = "status err";
  }
});

/* ---------------- Toggles ---------------- */

$("toggleAutoSync").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ autoSync: e.target.checked });
  $("manualSync").classList.toggle("hidden", e.target.checked);
  await load();
});

$("toggleAI").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ aiEnabled: e.target.checked });
});

/* ---------------- Manual sync ---------------- */

$("manualSync").addEventListener("click", async () => {
  const btn = $("manualSync");
  btn.disabled = true;
  btn.textContent = "Syncing…";
  const res = await send("MANUAL_SYNC", {});
  btn.disabled = false;
  btn.textContent = "Sync Last Submission";
  if (!res?.ok) {
    const box = $("statusBox");
    box.className = "status err";
    box.classList.remove("hidden");
    box.textContent = "Manual sync failed: " + (res?.error || "unknown");
  }
  await load();
});

/* ---------------- Clear history ---------------- */

$("clearHistory").addEventListener("click", async () => {
  if (!confirm("Clear all local history and stats?")) return;
  await chrome.storage.local.set({
    history: [],
    stats: { solved: 0, easy: 0, medium: 0, hard: 0, byLanguage: {} },
    streak: 0,
    lastActiveDate: ""
  });
  await load();
});

/* ---------------- Live updates ---------------- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes.history || changes.stats || changes.lastSync ||
    changes.syncError || changes.autoSync || changes.streak
  ) load();
});

load();
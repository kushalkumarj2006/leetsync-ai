/* ============================================================
   LeetSync AI — Background Service Worker
   ============================================================ */

const GITHUB_API = "https://api.github.com";
const OFFSCREEN_PATH = "offscreen/offscreen.html";

/* ---------------- Language mapping ---------------- */

function normalizeLanguage(rawLang) {
  if (!rawLang) return { family: "unknown" };
  const l = String(rawLang).toLowerCase();

  if (["sql", "mysql", "postgresql", "mssql", "ms sql server", "oracle"].includes(l))
    return { family: "sql" };
  if (l === "pandas") return { family: "pandas" };

  const codeMap = {
    python: "python", python3: "python",
    javascript: "javascript", typescript: "javascript",
    java: "java", cpp: "cpp", "c++": "cpp", c: "c",
    csharp: "csharp", "c#": "csharp",
    go: "go", kotlin: "kotlin", swift: "swift", rust: "rust",
    ruby: "ruby", php: "php", dart: "dart", scala: "scala",
    racket: "racket", erlang: "erlang", elixir: "elixir"
  };
  if (codeMap[l]) return { family: "code", language: codeMap[l] };
  return { family: "unknown" };
}

function getPath(langInfo, slug) {
  const snake = slug.replace(/-/g, "_");
  if (langInfo.family === "sql") return `database/sql/${snake}.sql`;
  if (langInfo.family === "pandas") return `database/pandas/${snake}.py`;

  const map = {
    python: ["python", "py"], javascript: ["javascript", "js"],
    java: ["java", "java"], cpp: ["cpp", "cpp"], c: ["c", "c"],
    csharp: ["csharp", "cs"], go: ["go", "go"], kotlin: ["kotlin", "kt"],
    swift: ["swift", "swift"], rust: ["rust", "rs"], ruby: ["ruby", "rb"],
    php: ["php", "php"], dart: ["dart", "dart"], scala: ["scala", "scala"],
    racket: ["racket", "rkt"], erlang: ["erlang", "erl"], elixir: ["elixir", "ex"]
  };
  const cfg = map[langInfo.language];
  if (!cfg) throw new Error("Unsupported language: " + langInfo.language);
  return `${cfg[0]}/${snake}.${cfg[1]}`;
}

function commentPrefix(langInfo) {
  if (langInfo.family === "sql") return "--";
  if (langInfo.family === "pandas") return "#";
  if (langInfo.family === "code" && langInfo.language === "python") return "#";
  return "//";
}

function base64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64Decode(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\s/g, ""))));
}

function buildHeader({ title, slug, difficulty, topicTags, rawLanguage, langInfo, aiExplanation }) {
  const p = commentPrefix(langInfo);
  const line = `${p} ================================================`;
  const url = `https://leetcode.com/problems/${slug}/`;
  const topics = (topicTags || []).join(", ") || "—";
  let out = [
    line,
    `${p} ${title}`,
    `${p} Difficulty : ${difficulty || "Unknown"}`,
    `${p} Topics     : ${topics}`,
    `${p} Language   : ${rawLanguage}`,
    `${p} Link       : ${url}`,
    `${p} Synced     : ${new Date().toLocaleString()}`,
    `${p} ================================================`
  ].join("\n");

  if (aiExplanation && aiExplanation.trim()) {
    out += "\n" + p + " AI Explanation:\n";
    for (const ln of aiExplanation.trim().split(/\r?\n/)) {
      out += `${p} ${ln}\n`;
    }
  }
  return out.trimStart() + "\n\n";
}

/* ---------------- Config ---------------- */

async function getCfg() {
  return await chrome.storage.local.get([
    "backendBase",
    "githubOwner", "githubRepo", "githubToken", "autoSync",
    "aiEnabled", "deepseekToken", "deepseekSmid",
    "stats", "history", "streak", "lastActiveDate",
    "videoCache"
  ]);
}

async function setSyncError(msg) {
  await chrome.storage.local.set({ syncError: { message: msg, time: Date.now() } });
}

/* ---------------- Offscreen lifecycle ---------------- */

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS"],
    justification: "Run WASM SHA3 worker for DeepSeek proof-of-work challenges."
  });
}

async function callOffscreen(payload) {
  await ensureOffscreen();
  return await chrome.runtime.sendMessage({ target: "offscreen", ...payload });
}

/* ---------------- DeepSeek ---------------- */

async function deepseekComplete(prompt, opts = {}) {
  const cfg = await getCfg();
  if (!cfg.deepseekToken) throw new Error("DeepSeek credentials not set.");
  if (!cfg.backendBase) throw new Error("Backend URL not set.");

  const res = await callOffscreen({
    type: "DEEPSEEK_COMPLETE",
    prompt,
    userToken: cfg.deepseekToken,
    smidV2: cfg.deepseekSmid || "",
    backendBase: cfg.backendBase,
    searchEnabled: !!opts.searchEnabled
  });
  if (!res || !res.ok) throw new Error(res?.error || "DeepSeek call failed");
  return res.text;
}

/* ---------------- GitHub ---------------- */

async function ghGet(owner, repo, token, path) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "LeetSync-AI"
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function ghPut(owner, repo, token, path, content, message, sha) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
  const body = {
    message,
    content: base64Encode(content),
    committer: { name: "LeetSync AI", email: "leetsync-ai@users.noreply.github.com" }
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "LeetSync-AI"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

async function pushFileWithRetry({ owner, repo, token, path, content, message }) {
  const existing = await ghGet(owner, repo, token, path);
  try {
    return await ghPut(owner, repo, token, path, content, message, existing?.sha);
  } catch (e) {
    if (e.status === 409) {
      const fresh = await ghGet(owner, repo, token, path);
      return await ghPut(owner, repo, token, path, content, message, fresh?.sha);
    }
    throw e;
  }
}

/* ---------------- Root README ---------------- */

const RM_START = "<!-- LEETSYNC_START -->";
const RM_END = "<!-- LEETSYNC_END -->";

function buildReadmeSection(history) {
  const groups = {};
  for (const item of history) {
    const primary = (item.topics && item.topics[0]) || "Misc";
    (groups[primary] = groups[primary] || []).push(item);
  }
  const topics = Object.keys(groups).sort();
  let md = "## 📚 Solutions Index\n\n";
  md += `_Auto-generated by LeetSync AI — ${history.length} problems_\n\n`;
  for (const t of topics) {
    md += `### ${t}\n\n`;
    md += "| # | Problem | Difficulty | Solution |\n";
    md += "|---|---------|------------|----------|\n";
    for (const it of groups[t].sort((a, b) => (a.number || 0) - (b.number || 0))) {
      md += `| ${it.number || "—"} | [${it.title}](https://leetcode.com/problems/${it.slug}/) | ${it.difficulty || "—"} | [${it.lang}](./${it.path}) |\n`;
    }
    md += "\n";
  }
  return md;
}

function mergeReadme(original, section) {
  if (!original) {
    return `# LeetCode Solutions\n\nAutomatically synced from LeetCode by [LeetSync AI].\n\n${RM_START}\n${section}${RM_END}\n`;
  }
  const s = original.indexOf(RM_START);
  const e = original.indexOf(RM_END);
  if (s === -1 || e === -1 || e < s) {
    return original + `\n\n${RM_START}\n${section}${RM_END}\n`;
  }
  return original.slice(0, s) + RM_START + "\n" + section + RM_END + original.slice(e + RM_END.length);
}

async function updateRootReadme(owner, repo, token) {
  const cfg = await getCfg();
  const section = buildReadmeSection(cfg.history || []);
  const existing = await ghGet(owner, repo, token, "README.md");
  let original = "";
  if (existing && existing.content) {
    try { original = base64Decode(existing.content); } catch {}
  }
  await pushFileWithRetry({
    owner, repo, token, path: "README.md",
    content: mergeReadme(original, section),
    message: "docs: update solutions index [LeetSync AI]"
  });
}

/* ---------------- Stats ---------------- */

const todayStr = () => new Date().toISOString().slice(0, 10);
function yesterdayStr() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function bumpStats({ difficulty, language, slug, title, number, topics, path }) {
  const cfg = await getCfg();
  const stats = cfg.stats || { solved: 0, easy: 0, medium: 0, hard: 0, byLanguage: {} };
  const history = cfg.history || [];

  const already = history.find(h => h.slug === slug && h.lang === language);
  if (!already) {
    stats.solved++;
    const d = (difficulty || "").toLowerCase();
    if (d === "easy") stats.easy++;
    else if (d === "medium") stats.medium++;
    else if (d === "hard") stats.hard++;
    stats.byLanguage[language] = (stats.byLanguage[language] || 0) + 1;
  }

  const today = todayStr();
  let streak = cfg.streak || 0;
  let lastActiveDate = cfg.lastActiveDate || "";
  if (lastActiveDate !== today) {
    if (lastActiveDate === yesterdayStr()) streak++;
    else streak = 1;
    lastActiveDate = today;
  }

  const entry = { slug, title, number, difficulty, lang: language, topics: topics || [], path, time: Date.now() };
  const filtered = history.filter(h => !(h.slug === slug && h.lang === language));
  filtered.unshift(entry);

  await chrome.storage.local.set({
    stats, history: filtered.slice(0, 500), streak, lastActiveDate, syncError: null
  });
}

/* ---------------- Notifications ---------------- */

async function notify(title, message, ok = true) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("media/icon.png"),
      title: (ok ? "✅ " : "⚠️ ") + title,
      message: String(message).slice(0, 200)
    });
  } catch {}
}

/* ---------------- Accepted submission flow ---------------- */

async function handleAcceptedSubmission({ slug, language, code, meta }) {
  const cfg = await getCfg();
  const langInfo = normalizeLanguage(language);
  if (langInfo.family === "unknown") {
    return { ok: false, error: "Unsupported language: " + language };
  }

  const path = getPath(langInfo, slug);

  let aiExplanation = "";
  if (cfg.aiEnabled && cfg.deepseekToken && cfg.backendBase) {
    try {
      const prompt =
        `Write a 2-3 sentence explanation of this LeetCode solution. ` +
        `Include time and space complexity. Output only the explanation, ` +
        `no headings, no markdown, no code, no bullet points.\n\n` +
        `Problem: ${meta.title} (${meta.difficulty})\n` +
        `Language: ${language}\n\nCode:\n${code}`;
      aiExplanation = await deepseekComplete(prompt, { searchEnabled: false });
    } catch (e) {
      console.warn("[LeetSync] AI explanation failed:", e.message);
    }
  }

  const header = buildHeader({
    title: meta.title, slug, difficulty: meta.difficulty,
    topicTags: meta.topics, rawLanguage: language, langInfo, aiExplanation
  });
  const finalCode = header + code;

  await chrome.storage.local.set({
    lastSubmission: { slug, language, code, meta, path, timestamp: Date.now() },
    lastAccepted: { path, time: Date.now() }
  });

  if (cfg.autoSync === false) return { ok: true, skipped: true, path };

  if (!cfg.githubOwner || !cfg.githubRepo || !cfg.githubToken) {
    await setSyncError("GitHub not configured.");
    return { ok: false, error: "GitHub not configured" };
  }

  try {
    await pushFileWithRetry({
      owner: cfg.githubOwner, repo: cfg.githubRepo, token: cfg.githubToken,
      path, content: finalCode,
      message: `solve: ${meta.title} (${language}) [LeetSync AI]`
    });

    await bumpStats({
      difficulty: meta.difficulty, language, slug, title: meta.title,
      number: meta.number, topics: meta.topics, path
    });

    try { await updateRootReadme(cfg.githubOwner, cfg.githubRepo, cfg.githubToken); }
    catch (e) { console.warn("[LeetSync] README update failed:", e.message); }

    await chrome.storage.local.set({ lastSync: { path, time: Date.now() }, syncError: null });
    await notify("Synced to GitHub", `${meta.title} → ${path}`);
    return { ok: true, path };
  } catch (e) {
    console.error("[LeetSync] Push failed:", e);
    await setSyncError(e.message);
    await notify("Sync failed", e.message, false);
    return { ok: false, error: e.message };
  }
}

async function handleManualSync() {
  const cfg = await getCfg();
  const sub = cfg.lastSubmission;
  if (!sub) return { ok: false, error: "No submission cached" };
  return await handleAcceptedSubmission({
    slug: sub.slug, language: sub.language, code: sub.code, meta: sub.meta
  });
}

/* ---------------- Message router ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return false;

  (async () => {
    try {
      switch (msg.type) {

        case "EXTRACT_CODE_REQUEST": {
          const tabId = sender.tab?.id;
          if (!tabId) { sendResponse({ code: "", language: "unknown" }); break; }
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => {
              let code = "", language = "unknown";
              if (window.monaco && window.monaco.editor) {
                const models = window.monaco.editor.getModels();
                if (models.length > 0) {
                  code = models[0].getValue();
                  language = models[0].getLanguageId();
                }
              }
              return { code, language };
            }
          });
          sendResponse(results?.[0]?.result || { code: "", language: "unknown" });
          break;
        }

        case "SUBMISSION_ACCEPTED":
          sendResponse(await handleAcceptedSubmission(msg.payload));
          break;

        case "MANUAL_SYNC":
          sendResponse(await handleManualSync());
          break;

        case "VERIFY_GITHUB": {
          const { owner, repo, token } = msg.payload;
          const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "LeetSync-AI"
            }
          });
          if (res.status === 401) sendResponse({ success: false, error: "Invalid token" });
          else if (res.status === 403) sendResponse({ success: false, error: "No access to repo" });
          else if (res.status === 404) sendResponse({ success: false, error: "Repo not found" });
          else if (!res.ok) sendResponse({ success: false, error: `GitHub ${res.status}` });
          else sendResponse({ success: true });
          break;
        }

        case "AI_HINT": {
          const { title, difficulty, description, code, language } = msg.payload;
          const prompt =
            `I'm solving this LeetCode problem.\n\n` +
            `Title: ${title}\nDifficulty: ${difficulty}\n` +
            `Description:\n${(description || "").slice(0, 2500)}\n\n` +
            `My current code (${language}):\n${code}\n\n` +
            `Give me a short, focused hint (2-4 bullet points). Do NOT write the full solution. ` +
            `Focus on: (1) whether my approach is on the right track, ` +
            `(2) any obvious edge cases I'm missing, (3) time/space complexity concerns.`;
          const text = await deepseekComplete(prompt, { searchEnabled: false });
          sendResponse({ ok: true, text });
          break;
        }

        case "AI_COMPARE": {
          const { title, difficulty, code, language, description } = msg.payload;
          const prompt =
            `Compare my solution to the optimal approach for this LeetCode problem.\n\n` +
            `Problem: ${title} (${difficulty})\nLanguage: ${language}\n\n` +
            `Problem description:\n${(description || "").slice(0, 2000)}\n\n` +
            `My solution:\n${code}\n\n` +
            `Output exactly this format:\n` +
            `- My time complexity: O(...)\n` +
            `- My space complexity: O(...)\n` +
            `- Optimal time complexity: O(...)\n` +
            `- Optimal space complexity: O(...)\n` +
            `- Verdict: one sentence on whether I'm optimal or suboptimal.\n` +
            `- If suboptimal: describe the better approach's idea in 2-3 sentences. Just the idea, no code.\n\n` +
            `Keep the whole answer under 150 words. No code blocks.`;
          const text = await deepseekComplete(prompt, { searchEnabled: false });
          sendResponse({ ok: true, text });
          break;
        }

        case "AI_SLOW": {
          const { title, difficulty, code, language, description } = msg.payload;
          const prompt =
            `My LeetCode solution is accepted but its runtime and memory percentile is low. ` +
            `Analyze the bottleneck.\n\n` +
            `Problem: ${title} (${difficulty})\nLanguage: ${language}\n\n` +
            `Problem description:\n${(description || "").slice(0, 2000)}\n\n` +
            `My solution:\n${code}\n\n` +
            `Output:\n` +
            `- Point to the exact lines or patterns slowing it down (be specific).\n` +
            `- Explain WHY they're slow.\n` +
            `- Suggest the category of fix (no code).\n\n` +
            `Keep it under 150 words. Concrete and technical. No code blocks.`;
          const text = await deepseekComplete(prompt, { searchEnabled: false });
          sendResponse({ ok: true, text });
          break;
        }

        case "FETCH_VIDEOS": {
          const cfg = await getCfg();
          if (!cfg.backendBase) {
            sendResponse({ ok: false, error: "Backend URL not set. Open the extension popup to configure." });
            break;
          }
          const { number, title } = msg.payload;
          const q = encodeURIComponent(`leetcode ${number || ""} ${title} solution`.trim());
          const url = `${cfg.backendBase.replace(/\/+$/, "")}/api/videos?q=${q}&n=8`;
          try {
            const res = await fetch(url);
            if (!res.ok) {
              sendResponse({ ok: false, error: `Backend ${res.status}` });
              break;
            }
            const j = await res.json();
            sendResponse({ ok: true, videos: j.results || [] });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }

        case "DEEPSEEK_PING": {
          const r = await callOffscreen({ type: "PING" });
          sendResponse(r || { ok: false });
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (e) {
      console.error("[LeetSync] Handler error:", e);
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});

/* ---------------- Install ---------------- */

chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await chrome.storage.local.get(["autoSync", "aiEnabled", "backendBase"]);
  const set = {};
  if (cfg.autoSync === undefined) set.autoSync = true;
  if (cfg.aiEnabled === undefined) set.aiEnabled = false;
  if (Object.keys(set).length) await chrome.storage.local.set(set);
});

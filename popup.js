// popup.js — BFS UI + working menu + Wikipedia autocomplete (Start/Goal)

const $ = (id) => document.getElementById(id);

// --------------------
// Wikipedia autocomplete config
// --------------------
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const SUGGEST_MIN_CHARS = 2;
const SUGGEST_LIMIT = 8;
const SUGGEST_DEBOUNCE_MS = 150;

// --------------------
// Elements
// --------------------
const startEl = $("start");
const goalEl = $("goal");
const depthEl = $("depth");
const maxLinksEl = $("maxLinks");
const maxBacklinksEl = $("maxBacklinks");
const concurrencyEl = $("concurrency");
const filterBadEl = $("filterBad");

const goBtn = $("go");
const stopBtn = $("stop");

const statusEl = $("status");
const timingEl = $("timing");
const resultsCard = $("resultsCard");
const resultEl = $("result");
const clickCountEl = $("clickCount");
const spinnerEl = $("spinner");
const barFillEl = $("barFill");
const confettiLayer = $("confetti");

// Menu
const menuBtn = $("menuBtn");
const backBtn = $("backBtn");
const menuView = $("menuView");

// Menu value mirrors
const sDepth = $("sDepth");
const sCaps = $("sCaps");
const sConc = $("sConc");
const sFilter = $("sFilter");

// --------------------
// State
// --------------------
let currentJobId = null;
let searchStartMs = 0;
let lastProgress = null;

// Autocomplete state per input
const acState = new WeakMap(); // inputEl -> { box, items, activeIdx, abortCtrl, lastQuery }

// --------------------
// Small UI helpers
// --------------------
function setStatus(s) {
  if (statusEl) statusEl.textContent = s;
}
function setTiming(s) {
  if (timingEl) timingEl.textContent = s || "";
}
function setBar(pct) {
  if (!barFillEl) return;
  barFillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function clearResults() {
  if (!resultEl || !resultsCard) return;
  resultEl.innerHTML = "";
  resultsCard.classList.add("hidden");
}

function renderPath(path) {
  if (!resultEl || !resultsCard || !clickCountEl) return;

  resultEl.innerHTML = "";
  for (const title of path) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
    a.textContent = title;
    a.target = "_blank";
    a.rel = "noreferrer";
    li.appendChild(a);
    resultEl.appendChild(li);
  }
  clickCountEl.textContent = `${path.length - 1} clicks`;
  resultsCard.classList.remove("hidden");
}

function setRunning(running) {
  if (goBtn) goBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;
  if (spinnerEl) spinnerEl.classList.toggle("hidden", !running);

  for (const el of [startEl, goalEl, depthEl, maxLinksEl, maxBacklinksEl, concurrencyEl, filterBadEl]) {
    if (el) el.disabled = running;
  }

  if (menuBtn) menuBtn.disabled = running;

  // disable autocomplete while running
  if (running) {
    closeSuggest(startEl);
    closeSuggest(goalEl);
  }
}

function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${r}s`;
}

function computeEta(progress) {
  if (!progress) return null;
  const { depthCeiling, tryingDepth, elapsedMs } = progress;
  if (!depthCeiling || !tryingDepth || tryingDepth <= 0) return null;
  const avgPerDepth = elapsedMs / Math.max(1, tryingDepth);
  const remainingDepths = Math.max(0, depthCeiling - tryingDepth);
  return avgPerDepth * remainingDepths;
}

function confettiBurst() {
  if (!confettiLayer) return;
  confettiLayer.innerHTML = "";
  const colors = ["#7c5cff", "#22c55e", "#ffffff", "#ffd166", "#60a5fa"];
  const pieces = 60;

  for (let i = 0; i < pieces; i++) {
    const d = document.createElement("div");
    d.className = "confetti";
    d.style.left = `${Math.random() * 100}%`;
    d.style.top = `${-10 - Math.random() * 30}px`;
    d.style.background = colors[Math.floor(Math.random() * colors.length)];
    d.style.transform = `rotate(${Math.random() * 180}deg)`;
    d.style.animationDelay = `${Math.random() * 120}ms`;
    d.style.width = `${6 + Math.random() * 8}px`;
    d.style.height = `${8 + Math.random() * 14}px`;
    confettiLayer.appendChild(d);
  }

  setTimeout(() => (confettiLayer.innerHTML = ""), 1400);
}

// --------------------
// Menu logic
// --------------------
function syncMenuSettings() {
  if (sDepth && depthEl) sDepth.textContent = String(depthEl.value);
  if (sCaps && maxLinksEl && maxBacklinksEl) sCaps.textContent = `${maxLinksEl.value} / ${maxBacklinksEl.value}`;
  if (sConc && concurrencyEl) sConc.textContent = String(concurrencyEl.value);
  if (sFilter && filterBadEl) sFilter.textContent = filterBadEl.value === "on" ? "On" : "Off";
}

function openMenu() {
  if (!menuView) return;
  syncMenuSettings();
  menuView.classList.add("open");
  menuView.setAttribute("aria-hidden", "false");
}

function closeMenu() {
  if (!menuView) return;
  menuView.classList.remove("open");
  menuView.setAttribute("aria-hidden", "true");
}

function wireMenu() {
  if (!menuBtn || !backBtn || !menuView) return;

  menuBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu();
  });

  backBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  });

  for (const el of [depthEl, maxLinksEl, maxBacklinksEl, concurrencyEl, filterBadEl]) {
    if (!el) continue;
    el.addEventListener("input", () => {
      if (menuView.classList.contains("open")) syncMenuSettings();
    });
    el.addEventListener("change", () => {
      if (menuView.classList.contains("open")) syncMenuSettings();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
}

// --------------------
// Autocomplete helpers
// --------------------
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function ensureSuggestBox(inputEl) {
  let st = acState.get(inputEl);
  if (st?.box) return st;

  const box = document.createElement("div");
  box.className = "suggestBox hidden";
  box.setAttribute("role", "listbox");

  // Put the dropdown right after the input (so it sits under it)
  inputEl.insertAdjacentElement("afterend", box);

  st = {
    box,
    items: [],
    activeIdx: -1,
    abortCtrl: null,
    lastQuery: "",
  };
  acState.set(inputEl, st);
  return st;
}

function closeSuggest(inputEl) {
  const st = acState.get(inputEl);
  if (!st) return;
  st.items = [];
  st.activeIdx = -1;
  if (st.box) {
    st.box.innerHTML = "";
    st.box.classList.add("hidden");
  }
}

function openSuggest(inputEl) {
  const st = acState.get(inputEl);
  if (!st?.box) return;
  st.box.classList.remove("hidden");
}

function renderSuggest(inputEl, titles) {
  const st = ensureSuggestBox(inputEl);

  st.items = titles.slice(0, SUGGEST_LIMIT);
  st.activeIdx = -1;

  st.box.innerHTML = "";
  if (st.items.length === 0) {
    closeSuggest(inputEl);
    return;
  }

  for (let i = 0; i < st.items.length; i++) {
    const title = st.items[i];
    const row = document.createElement("div");
    row.className = "suggestItem";
    row.setAttribute("role", "option");
    row.textContent = title;

    row.addEventListener("mousedown", (e) => {
      // mousedown so it fires before input blur
      e.preventDefault();
      inputEl.value = title;
      closeSuggest(inputEl);
      inputEl.focus();
    });

    st.box.appendChild(row);
  }

  openSuggest(inputEl);
}

function setActiveSuggest(inputEl, idx) {
  const st = acState.get(inputEl);
  if (!st?.box) return;
  const kids = Array.from(st.box.children);
  kids.forEach((el) => el.classList.remove("active"));

  if (idx >= 0 && idx < kids.length) {
    kids[idx].classList.add("active");
    st.activeIdx = idx;

    // keep visible
    kids[idx].scrollIntoView({ block: "nearest" });
  } else {
    st.activeIdx = -1;
  }
}

async function fetchWikiSuggestions(q, signal) {
  // MediaWiki OpenSearch returns: [query, [titles...], [descriptions...], [urls...]]
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "opensearch");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  url.searchParams.set("limit", String(SUGGEST_LIMIT));
  url.searchParams.set("namespace", String(NS_MAIN));
  url.searchParams.set("search", q);

  const res = await fetch(url.toString(), { method: "GET", signal });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const titles = Array.isArray(data?.[1]) ? data[1] : [];
  return titles;
}

function wireAutocomplete(inputEl) {
  if (!inputEl) return;

  ensureSuggestBox(inputEl);

  const debounced = debounce(async () => {
    const st = ensureSuggestBox(inputEl);
    const q = (inputEl.value || "").trim();

    // close if too short or looks like URL (user may be pasting)
    if (q.length < SUGGEST_MIN_CHARS || q.startsWith("http://") || q.startsWith("https://")) {
      closeSuggest(inputEl);
      return;
    }

    // do not repeat same query
    if (q === st.lastQuery) return;
    st.lastQuery = q;

    // abort previous in-flight
    if (st.abortCtrl) st.abortCtrl.abort();
    st.abortCtrl = new AbortController();

    const titles = await fetchWikiSuggestions(q, st.abortCtrl.signal).catch(() => []);
    renderSuggest(inputEl, titles);
  }, SUGGEST_DEBOUNCE_MS);

  inputEl.addEventListener("input", () => {
    debounced();
  });

  inputEl.addEventListener("focus", () => {
    // if there's already content and items, re-open
    const st = acState.get(inputEl);
    if (st?.items?.length) openSuggest(inputEl);
  });

  inputEl.addEventListener("blur", () => {
    // delay so click can register
    setTimeout(() => closeSuggest(inputEl), 120);
  });

  inputEl.addEventListener("keydown", (e) => {
    const st = acState.get(inputEl);
    if (!st?.box || st.box.classList.contains("hidden")) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(st.items.length - 1, (st.activeIdx ?? -1) + 1);
      setActiveSuggest(inputEl, next);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = Math.max(0, (st.activeIdx ?? 0) - 1);
      setActiveSuggest(inputEl, prev);
      return;
    }

    if (e.key === "Enter") {
      if (st.activeIdx >= 0 && st.activeIdx < st.items.length) {
        e.preventDefault();
        inputEl.value = st.items[st.activeIdx];
        closeSuggest(inputEl);
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      closeSuggest(inputEl);
    }
  });
}

// Close suggestions if user clicks elsewhere
document.addEventListener("mousedown", (e) => {
  const t = e.target;
  // don't close if clicking inside a suggest box
  if (t?.classList?.contains("suggestItem") || t?.classList?.contains("suggestBox")) return;
  closeSuggest(startEl);
  closeSuggest(goalEl);
});

// --------------------
// Main BFS actions
// --------------------
async function startSearch() {
  const start = startEl?.value.trim() ?? "";
  const goal = goalEl?.value.trim() ?? "";
  if (!start || !goal) {
    setStatus("Enter both start and goal.");
    return;
  }

  closeSuggest(startEl);
  closeSuggest(goalEl);

  clearResults();
  setStatus("Starting…");
  setTiming("");
  setBar(0);
  setRunning(true);

  searchStartMs = Date.now();
  lastProgress = null;

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: "START",
      start,
      goal,
      depthCeiling: Number(depthEl?.value || 12),
      maxLinks: Number(maxLinksEl?.value || 300),
      maxBacklinks: Number(maxBacklinksEl?.value || 300),
      concurrency: Number(concurrencyEl?.value || 10),
      filterBad: (filterBadEl?.value || "on") === "on",
    });
  } catch (e) {
    setStatus(`Error: ${e?.message ?? String(e)}`);
    setRunning(false);
    return;
  }

  currentJobId = resp?.jobId || null;
  if (!currentJobId) {
    setStatus("Failed to start job.");
    setRunning(false);
  }
}

async function stopSearch() {
  if (!currentJobId) return;
  try {
    await chrome.runtime.sendMessage({ type: "STOP", jobId: currentJobId });
  } catch {
    // ignore
  }

  setStatus("Stopped.");
  setTiming("");
  setBar(0);
  setRunning(false);

  currentJobId = null;
  lastProgress = null;
}

// --------------------
// Worker messages
// --------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.jobId !== currentJobId) return;

  if (msg.type === "PROGRESS") {
    lastProgress = msg;

    const elapsedMs = msg.elapsedMs ?? (Date.now() - searchStartMs);
    const etaMs = computeEta({ ...msg, elapsedMs });

    const depthCeiling = msg.depthCeiling ?? Number(depthEl?.value || 12);
    const tryingDepth = msg.tryingDepth ?? 1;
    const layer = msg.layer ?? 0;
    const depthLimit = msg.depthLimit ?? tryingDepth;

    setStatus(msg.label || "Working…");
    setTiming(`Elapsed ${fmtMs(elapsedMs)}${etaMs ? ` • ETA ~${fmtMs(etaMs)}` : ""}`);

    const base = (tryingDepth - 1) / Math.max(1, depthCeiling);
    const intra = (layer / Math.max(1, depthLimit)) / Math.max(1, depthCeiling);
    setBar((base + intra) * 100);
  }

  if (msg.type === "DONE") {
    const elapsedMs = Date.now() - searchStartMs;

    if (msg.path) {
      setStatus(`Found path in ${fmtMs(elapsedMs)}.`);
      setTiming("");
      setBar(100);
      renderPath(msg.path);
      confettiBurst();
    } else {
      setStatus(`No path found (in ${fmtMs(elapsedMs)}).`);
      setTiming("Try increasing depth ceiling or link caps.");
      setBar(0);
      clearResults();
    }

    setRunning(false);
    currentJobId = null;
    lastProgress = null;
  }

  if (msg.type === "ERROR") {
    setStatus(`Error: ${msg.error}`);
    setTiming("");
    setBar(0);
    setRunning(false);

    currentJobId = null;
    lastProgress = null;
  }
});

// --------------------
// Wire everything
// --------------------
document.addEventListener("DOMContentLoaded", () => {
  wireMenu();

  // Autocomplete
  wireAutocomplete(startEl);
  wireAutocomplete(goalEl);

  goBtn?.addEventListener("click", startSearch);
  stopBtn?.addEventListener("click", stopSearch);

  setStatus("Ready.");
  syncMenuSettings();
});
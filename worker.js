// worker.js (MV3 service worker)
// FAST + correct bidirectional BFS up to depthCeiling (NO iterative deepening).
// Big speed wins:
//  - No repeated expansions
//  - Batched OUTLINK fetch via POST
//  - Session cache (chrome.storage.session) + in-memory cache
//
// Messages: START/STOP -> PROGRESS/DONE/ERROR
// PROGRESS payload stays compatible with your popup.js (label + timing fields).
// ERROR always includes jobId.

const API = "https://en.wikipedia.org/w/api.php";
const NS_MAIN = 0;

// ----------------------------------
// Job registry
// ----------------------------------
const jobs = new Map(); // jobId -> { id, startMs, stopped }

// ----------------------------------
// Utilities
// ----------------------------------
function mkJobId() {
  return `${Date.now()}-${crypto.randomUUID?.() ?? Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeInputToTitle(input) {
  const s = String(input ?? "").trim();
  if (!s) throw new Error("ERR_EMPTY_INPUT");

  if (s.startsWith("http://") || s.startsWith("https://")) {
    const u = new URL(s);
    if (u.hostname !== "en.wikipedia.org" && u.hostname !== "www.en.wikipedia.org") {
      throw new Error("ERR_ONLY_ENWIKI");
    }
    if (!u.pathname.startsWith("/wiki/")) {
      throw new Error("ERR_BAD_WIKI_URL");
    }
    return decodeURIComponent(u.pathname.slice("/wiki/".length)).replaceAll("_", " ");
  }

  return s.replaceAll("_", " ");
}

function makeBadPageFn(enabled) {
  if (!enabled) return () => false;
  return (title) => {
    const tl = String(title).toLowerCase();
    if (tl.startsWith("list of ")) return true;
    if (tl.includes("(disambiguation)")) return true;
    if (/^\d{3,4}$/.test(tl)) return true;
    return false;
  };
}

// ----------------------------------
// Error formatting (simple user-facing)
// ----------------------------------
function formatError(e, which = null) {
  const code = String(e?.message ?? e ?? "");

  if (code === "ERR_EMPTY_INPUT") return "Please enter both start and goal.";
  if (code === "ERR_ONLY_ENWIKI") return "Only en.wikipedia.org is supported.";
  if (code === "ERR_BAD_WIKI_URL") return "URL must start with https://en.wikipedia.org/wiki/...";

  if (code === "ERR_PAGE_NOT_FOUND") return which ? `${which} page not found.` : "Page not found.";
  if (code === "ERR_NOT_ARTICLE") return which ? `${which} must be a normal article page.` : "Must be a normal article page.";

  if (code.startsWith("HTTP_429")) return "Rate limited by Wikipedia. Lower concurrency and try again.";
  if (code.startsWith("HTTP_403")) return "Blocked by Wikipedia (403). Lower concurrency and try again.";
  if (code.startsWith("HTTP_5")) return "Wikipedia is temporarily unavailable. Try again.";

  return code.startsWith("HTTP_") ? "Network/API error. Try again." : "Error. Please try again.";
}

// ----------------------------------
// Concurrency limiter
// ----------------------------------
function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];

  const pump = () => {
    if (active >= maxConcurrent) return;
    const it = queue.shift();
    if (!it) return;

    active++;
    const { fn, resolve, reject } = it;

    Promise.resolve()
      .then(fn)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        active--;
        pump();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

// ----------------------------------
// Small capped cache (in-memory)
// ----------------------------------
class CappedCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  get(key) {
    return this.map.get(key);
  }
  has(key) {
    return this.map.has(key);
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

// ----------------------------------
// Session cache helpers (chrome.storage.session)
// ----------------------------------
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function sessionGet(key) {
  try {
    if (!chrome?.storage?.session) return null;
    const obj = await chrome.storage.session.get(key);
    const rec = obj?.[key];
    if (!rec || typeof rec !== "object") return null;
    if (Date.now() - (rec.t ?? 0) > SESSION_TTL_MS) return null;
    return rec.v ?? null;
  } catch {
    return null;
  }
}

async function sessionSet(key, value) {
  try {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.set({ [key]: { t: Date.now(), v: value } });
  } catch {
    // ignore quota/serialization issues
  }
}

// ----------------------------------
// Messaging helpers
// ----------------------------------
function sendProgress(job, label, extra = {}) {
  chrome.runtime.sendMessage({
    type: "PROGRESS",
    jobId: job.id,
    label,
    elapsedMs: Date.now() - job.startMs,
    ...extra,
  });
}

function sendDone(jobId, path) {
  chrome.runtime.sendMessage({ type: "DONE", jobId, path });
}

function sendError(jobId, msg) {
  chrome.runtime.sendMessage({ type: "ERROR", jobId, error: msg });
}

// ----------------------------------
// MediaWiki API client (POST + retry + inflight dedupe)
// ----------------------------------
class WikiApi {
  constructor({ memCacheSize = 60000 } = {}) {
    this.titleCache = new CappedCache(memCacheSize); // validation/resolve
    this.outCache = new CappedCache(memCacheSize);
    this.backCache = new CappedCache(memCacheSize);
    this.inflight = new Map(); // key -> Promise
  }

  async requestJson(params, { retries = 6 } = {}) {
    // POST avoids URL-length limits and lets you batch more safely
    const body = new URLSearchParams({ ...params, origin: "*" });

    let backoff = 200;
    for (let i = 0; i < retries; i++) {
      const res = await fetch(API, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body,
      });

      if ([429, 502, 503, 504].includes(res.status)) {
        await sleep(backoff + Math.random() * 120);
        backoff = Math.min(backoff * 2, 2500);
        continue;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP_${res.status}:${txt.slice(0, 120)}`);
      }

      return await res.json();
    }

    throw new Error("HTTP_RETRY_EXHAUSTED");
  }

  // Strict validation: exists + main namespace + redirect-resolved canonical title
  async validateAndResolve(rawTitle) {
    const memKey = `validate||${rawTitle}`;
    const cached = this.titleCache.get(memKey);
    if (cached) return cached;

    // small session cache: validation results are stable
    const sessKey = `v1|val|${rawTitle}`;
    const sess = await sessionGet(sessKey);
    if (typeof sess === "string" && sess) {
      this.titleCache.set(memKey, sess);
      return sess;
    }

    const data = await this.requestJson({
      action: "query",
      format: "json",
      formatversion: 2,
      titles: rawTitle,
      redirects: 1,
      prop: "info",
    });

    const page = data?.query?.pages?.[0];
    if (!page || page.missing) throw new Error("ERR_PAGE_NOT_FOUND");
    if (page.ns !== NS_MAIN) throw new Error("ERR_NOT_ARTICLE");

    const title = page.title;
    this.titleCache.set(memKey, title);
    await sessionSet(sessKey, title);
    return title;
  }

  // Outlinks (batched). Cache key includes cap.
  async getOutlinksBatch(titles, cap, isBad) {
    const result = new Map();
    const need = [];

    for (const title of titles) {
      const key = `out||${title}||${cap}`;

      const mem = this.outCache.get(key);
      if (mem) {
        result.set(title, mem);
        continue;
      }

      need.push(title);
    }

    if (need.length === 0) return result;

    // Try session cache for all "need"
    const stillNeed = [];
    for (const title of need) {
      const sessKey = `v1|out|${cap}|${title}`;
      const sess = await sessionGet(sessKey);
      if (Array.isArray(sess)) {
        const key = `out||${title}||${cap}`;
        this.outCache.set(key, sess);
        result.set(title, sess);
      } else {
        stillNeed.push(title);
      }
    }
    if (stillNeed.length === 0) return result;

    // POST lets us safely batch more; still be reasonable to avoid huge payloads.
    const CHUNK = 50;

    for (let i = 0; i < stillNeed.length; i += CHUNK) {
      const chunk = stillNeed.slice(i, i + CHUNK);
      const inflightKey = `batchOut||${cap}||${chunk.join("||")}`;

      if (this.inflight.has(inflightKey)) {
        const fromOther = await this.inflight.get(inflightKey);
        for (const [k, v] of fromOther.entries()) result.set(k, v);
        continue;
      }

      const p = (async () => {
        const data = await this.requestJson({
          action: "query",
          format: "json",
          formatversion: 2,
          titles: chunk.join("|"),
          prop: "links",
          plnamespace: NS_MAIN,
          pllimit: "max",
        });

        const pages = data?.query?.pages || [];
        const outMap = new Map();

        for (const page of pages) {
          if (!page || page.missing) continue;
          const title = page.title;
          const links = page.links || [];
          const out = [];

          for (const link of links) {
            const t = link?.title;
            if (!t || isBad(t)) continue;
            out.push(t);
            if (out.length >= cap) break;
          }

          outMap.set(title, out);

          const key = `out||${title}||${cap}`;
          this.outCache.set(key, out);

          // session cache best-effort (avoid enormous entries)
          if (cap <= 1500 && out.length <= 1500) {
            await sessionSet(`v1|out|${cap}|${title}`, out);
          }
        }

        // ensure every requested title has an entry
        for (const t of chunk) if (!outMap.has(t)) outMap.set(t, []);
        return outMap;
      })();

      this.inflight.set(inflightKey, p);
      let outMap;
      try {
        outMap = await p;
      } finally {
        this.inflight.delete(inflightKey);
      }

      for (const [k, v] of outMap.entries()) result.set(k, v);
    }

    // ensure all requested titles exist in map
    for (const t of need) if (!result.has(t)) result.set(t, []);
    return result;
  }

  // Backlinks (single only; expensive). Cache includes cap.
  async getBacklinks(title, cap, isBad) {
    const memKey = `back||${title}||${cap}`;
    const mem = this.backCache.get(memKey);
    if (mem) return mem;

    const sessKey = `v1|back|${cap}|${title}`;
    const sess = await sessionGet(sessKey);
    if (Array.isArray(sess)) {
      this.backCache.set(memKey, sess);
      return sess;
    }

    const inflightKey = `back||${title}||${cap}`;
    if (this.inflight.has(inflightKey)) return this.inflight.get(inflightKey);

    const p = (async () => {
      const inc = [];
      let blcontinue = null;

      while (inc.length < cap) {
        const params = {
          action: "query",
          format: "json",
          formatversion: 2,
          list: "backlinks",
          bltitle: title,
          blnamespace: NS_MAIN,
          bllimit: "max",
        };
        if (blcontinue) params.blcontinue = blcontinue;

        const data = await this.requestJson(params);
        const backlinks = data?.query?.backlinks || [];

        for (const bl of backlinks) {
          const t = bl?.title;
          if (!t || isBad(t)) continue;
          inc.push(t);
          if (inc.length >= cap) break;
        }

        blcontinue = data?.continue?.blcontinue || null;
        if (!blcontinue) break;
      }

      this.backCache.set(memKey, inc);
      if (cap <= 1500 && inc.length <= 1500) {
        await sessionSet(sessKey, inc);
      }
      return inc;
    })();

    this.inflight.set(inflightKey, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(inflightKey);
    }
  }
}

// ----------------------------------
// Path reconstruction
// ----------------------------------
function reconstructPath(meet, parent, child) {
  const left = [];
  let cur = meet;
  while (cur != null) {
    left.push(cur);
    cur = parent.get(cur) ?? null;
  }
  left.reverse();

  const right = [];
  cur = child.get(meet) ?? null;
  while (cur != null) {
    right.push(cur);
    cur = child.get(cur) ?? null;
  }

  return left.concat(right);
}

// ----------------------------------
// Single bidirectional BFS up to depthCeiling (NO iterative deepening)
// Correctness: expands one full layer forward + one full layer backward per depth.
// ----------------------------------
async function findShortestPathBidirectional({
  job,
  api,
  start,
  goal,
  depthCeiling,
  maxLinks,
  maxBacklinks,
  concurrency,
  filterBad,
}) {
  if (start === goal) return [start];

  const limiter = createLimiter(Math.max(2, Math.min(30, Number(concurrency || 10))));
  const isBad = makeBadPageFn(!!filterBad);

  // frontiers
  let frontF = new Set([start]);
  let frontB = new Set([goal]);

  // visited
  const visitedF = new Set([start]);
  const visitedB = new Set([goal]);

  // parents for reconstruction
  const parent = new Map([[start, null]]);
  const child = new Map([[goal, null]]);

  // Depth loop: each "d" means we allow paths up to length 2d (roughly),
  // but we stop as soon as frontiers meet (shortest within caps).
  for (let d = 1; d <= depthCeiling; d++) {
    if (job.stopped) return null;
    sendProgress(job, `Depth ${d}`, {
      tryingDepth: d,
      depthCeiling,
      depthLimit: depthCeiling,
      layer: 0,
      frontier: frontF.size + frontB.size,
    });

    // ------------- expand FORWARD one layer -------------
    if (frontF.size > 0) {
      const pages = Array.from(frontF);
      frontF = new Set();

      const outMap = await limiter(() => api.getOutlinksBatch(pages, maxLinks, isBad));

      let meet = null;
      for (const p of pages) {
        if (job.stopped) return null;
        const links = outMap.get(p) || [];

        for (const nxt of links) {
          if (visitedF.has(nxt)) continue;
          visitedF.add(nxt);
          parent.set(nxt, p);

          if (visitedB.has(nxt)) {
            meet = nxt;
            break;
          }
          frontF.add(nxt);
        }
        if (meet) {
          return reconstructPath(meet, parent, child);
        }
      }
    }

    // ------------- expand BACKWARD one layer -------------
    if (job.stopped) return null;

    if (frontB.size > 0) {
      const pages = Array.from(frontB);
      frontB = new Set();

      const tasks = pages.map((p) =>
        limiter(() => api.getBacklinks(p, maxBacklinks, isBad))
          .then((preds) => ({ p, preds }))
          .catch(() => ({ p, preds: [] }))
      );

      const results = await Promise.all(tasks);

      let meet = null;
      for (const { p, preds } of results) {
        if (job.stopped) return null;

        for (const pred of preds) {
          if (visitedB.has(pred)) continue;
          visitedB.add(pred);
          child.set(pred, p);

          if (visitedF.has(pred)) {
            meet = pred;
            break;
          }
          frontB.add(pred);
        }
        if (meet) {
          return reconstructPath(meet, parent, child);
        }
      }
    }

    if (frontF.size === 0 && frontB.size === 0) return null;
  }

  return null;
}

// ----------------------------------
// Main message handler
// ----------------------------------
const apiSingleton = new WikiApi({ memCacheSize: 60000 });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    // START: respond immediately with jobId, then work.
    if (msg?.type === "START") {
      const jobId = mkJobId();
      const job = { id: jobId, startMs: Date.now(), stopped: false };
      jobs.set(jobId, job);

      sendResponse({ ok: true, jobId });

      try {
        sendProgress(job, "Locating pages…");

        const startRaw = normalizeInputToTitle(msg.start);
        const goalRaw = normalizeInputToTitle(msg.goal);

        let start, goal;
        try {
          start = await apiSingleton.validateAndResolve(startRaw);
        } catch (e) {
          throw new Error(formatError(e, "Start"));
        }
        try {
          goal = await apiSingleton.validateAndResolve(goalRaw);
        } catch (e) {
          throw new Error(formatError(e, "Goal"));
        }

        const depthCeiling = Math.max(1, Math.min(30, Number(msg.depthCeiling ?? 12)));
        const maxLinks = Math.max(50, Math.min(5000, Number(msg.maxLinks ?? 300)));
        const maxBacklinks = Math.max(50, Math.min(5000, Number(msg.maxBacklinks ?? 300)));
        const concurrency = Math.max(2, Math.min(30, Number(msg.concurrency ?? 10)));
        const filterBad = Boolean(msg.filterBad ?? true);

        const path = await findShortestPathBidirectional({
          job,
          api: apiSingleton,
          start,
          goal,
          depthCeiling,
          maxLinks,
          maxBacklinks,
          concurrency,
          filterBad,
        });

        if (!jobs.has(jobId) || job.stopped) {
          sendDone(jobId, null);
          jobs.delete(jobId);
          return;
        }

        sendDone(jobId, path);
        jobs.delete(jobId);
        return;
      } catch (e) {
        sendError(jobId, String(e?.message ?? e));
        jobs.delete(jobId);
        return;
      }
    }

    // STOP
    if (msg?.type === "STOP") {
      const job = jobs.get(msg.jobId);
      if (job) job.stopped = true;
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type." });
  })();

  return true;
});
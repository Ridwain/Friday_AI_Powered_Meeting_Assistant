// web-scraper.js
// Utilities for URL Q&A, web scraping+indexing, and SERP proxy

const SERVER_URL = "http://localhost:3000";

// ---- simple persisted cache of already-upserted URLs ----
const UPSERT_CACHE_KEY = "webUrlUpserts";
let upsertedUrlSet = new Set();

async function loadUpsertCache() {
  try {
    if (!chrome?.storage?.local) return;
    const result = await chrome.storage.local.get(UPSERT_CACHE_KEY);
    const arr = result?.[UPSERT_CACHE_KEY] || [];
    upsertedUrlSet = new Set(arr);
  } catch (e) {
    // ignore; non-fatal
  }
}
async function saveUpsertCache() {
  try {
    if (!chrome?.storage?.local) return;
    await chrome.storage.local.set({ [UPSERT_CACHE_KEY]: [...upsertedUrlSet] });
  } catch (e) {
    // ignore; non-fatal
  }
}

// Call this once from chat.js during init
export async function initWebScraper() {
  await loadUpsertCache();
}

// ---- helpers ----
export function isUrlLike(str = "") {
  return /^https?:\/\/\S+/i.test(String(str).trim());
}

export function detectWebSearchyQuery(q = "") {
  const s = q.toLowerCase();
  return /\b(search|google|bing|duckduckgo|latest|news|trending|what's new|recent|top results)\b/.test(
    s
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJSON(path, body, timeoutMs = 25000) {
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  };
  const r = await fetch(`${SERVER_URL}${path}`, opts);
  if (!r.ok) {
    let t = "";
    try {
      t = await r.text();
    } catch {}
    throw new Error(`${path} failed: ${r.status} ${t}`);
  }
  return r.json();
}

// ---- server calls ----
export async function scrapeUrl(url) {
  return postJSON("/scrape-url", { url }, 20000); // {title,url,text}
}

export async function scrapeAndUpsert(url, namespaceHint) {
  if (upsertedUrlSet.has(url)) {
    return { cached: true, message: "Already upserted (client cache)" };
  }
  const out = await postJSON(
    "/scrape-and-upsert",
    { url, namespaceHint },
    45000
  );
  if (out?.success) {
    upsertedUrlSet.add(url);
    await saveUpsertCache();
  }
  return out;
}

export async function serpSearch(q) {
  const j = await postJSON("/serp/search", { q }, 15000);
  return Array.isArray(j.results) ? j.results : [];
}

// ---- Drive link scanning & bulk index ----
const URL_RE = /https?:\/\/[^\s"')\]]+/g;

export function extractUrlsFromText(text = "") {
  return (text.match(URL_RE) || [])
    .filter(
      (u) => !/https:\/\/(drive\.google\.com|meet\.google\.com)\//.test(u)
    )
    .map((u) => u.replace(/[),.;]+$/, "").trim());
}

export async function indexUrlsFromFiles(
  filesContentMap = {},
  namespaceHint,
  throttleMs = 1400
) {
  const found = new Set();
  for (const text of Object.values(filesContentMap || {})) {
    if (!text || typeof text !== "string") continue;
    extractUrlsFromText(text).forEach((u) => found.add(u));
  }
  const list = [...found];
  if (!list.length) return { scanned: 0, queued: 0 };

  let ok = 0,
    fail = 0;
  for (const u of list) {
    try {
      if (upsertedUrlSet.has(u)) continue;
      await scrapeAndUpsert(u, namespaceHint);
      ok++;
      await sleep(throttleMs);
    } catch (e) {
      fail++;
      await sleep(Math.min(throttleMs * 2, 4000));
    }
  }
  return { scanned: list.length, upserted: ok, failed: fail };
}

// ---- prompt builder for page‑only Q&A ----
export function buildMessagesForUrlQA(question, scrapedText) {
  const context = (scrapedText || "").slice(0, 12000);
  return [
    {
      role: "system",
      content: `You are a precise assistant. Answer ONLY from the provided webpage content.
If the answer is not in the content, say you don't have enough info. Keep it concise.`,
    },
    { role: "system", content: `WEBPAGE CONTENT:\n${context}` },
    { role: "user", content: question },
  ];
}

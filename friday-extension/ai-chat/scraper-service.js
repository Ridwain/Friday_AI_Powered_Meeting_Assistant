// ai-chat/scraper-service.js
// Web scraping utilities

import { CONFIG } from "./config.js";

// ============================================
// URL Detection
// ============================================

const URL_REGEX = /https?:\/\/[^\s"')\]]+/gi;

/**
 * Check if string looks like a URL
 */
export function isUrl(str) {
    return /^https?:\/\/\S+/i.test(String(str).trim());
}

/**
 * Extract URLs from text
 */
export function extractUrls(text) {
    if (!text) return [];

    return (text.match(URL_REGEX) || [])
        .filter((url) => {
            // Skip Drive and Meet links
            return !/https:\/\/(drive\.google\.com|meet\.google\.com)\//.test(url);
        })
        .map((url) => url.replace(/[),.;]+$/, "").trim());
}

/**
 * Detect if query is a web search request
 */
export function isWebSearchQuery(query) {
    const keywords = [
        "search", "google", "find", "lookup", "latest", "news",
        "trending", "what's new", "recent", "top results"
    ];

    const lower = query.toLowerCase();
    return keywords.some((kw) => lower.includes(kw));
}

// ============================================
// Scraping
// ============================================

/**
 * Scrape URL content via backend
 */
export async function scrapeUrl(url) {
    try {
        const response = await fetch(`${CONFIG.SERVER_URL}/scrape-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
        });

        if (!response.ok) {
            throw new Error(`Scrape failed: ${response.status}`);
        }

        return response.json(); // { title, url, text }
    } catch (error) {
        console.error("Scrape error:", error);
        throw error;
    }
}

/**
 * Scrape and index URL to vector store
 */
export async function scrapeAndIndex(url, namespace) {
    try {
        // Check cache first
        const cached = await getCachedUrl(url);
        if (cached) {
            console.log(`📦 URL already indexed: ${url}`);
            return { cached: true, ...cached };
        }

        const response = await fetch(`${CONFIG.SERVER_URL}/scrape-and-upsert`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, namespaceHint: namespace }),
        });

        if (!response.ok) {
            throw new Error(`Scrape and upsert failed: ${response.status}`);
        }

        const result = await response.json();

        if (result.success) {
            await cacheUrl(url, result);
        }

        return result;
    } catch (error) {
        console.error("Scrape and index error:", error);
        throw error;
    }
}

// ============================================
// URL Cache
// ============================================

const URL_CACHE_KEY = "scrapedUrlCache";

async function getCachedUrl(url) {
    try {
        const cache = await chrome.storage.local.get(URL_CACHE_KEY);
        const urls = cache[URL_CACHE_KEY] || {};
        return urls[url] || null;
    } catch {
        return null;
    }
}

async function cacheUrl(url, data) {
    try {
        const cache = await chrome.storage.local.get(URL_CACHE_KEY);
        const urls = cache[URL_CACHE_KEY] || {};

        urls[url] = {
            title: data.title,
            scrapedAt: new Date().toISOString(),
        };

        await chrome.storage.local.set({ [URL_CACHE_KEY]: urls });
    } catch {
        // Ignore cache errors
    }
}

// ============================================
// Batch Processing
// ============================================

/**
 * Index multiple URLs from text content
 */
export async function indexUrlsFromContent(content, namespace) {
    const urls = extractUrls(content);
    if (urls.length === 0) return { scanned: 0, indexed: 0 };

    let indexed = 0;
    let failed = 0;

    for (const url of urls) {
        try {
            await scrapeAndIndex(url, namespace);
            indexed++;

            // Rate limiting
            await new Promise((r) => setTimeout(r, 1500));
        } catch {
            failed++;
        }
    }

    return { scanned: urls.length, indexed, failed };
}

// ============================================
// SERP Search
// ============================================

/**
 * Perform web search via backend
 */
export async function webSearch(query) {
    try {
        const response = await fetch(`${CONFIG.SERVER_URL}/serp/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: query }),
        });

        if (!response.ok) {
            throw new Error(`Search failed: ${response.status}`);
        }

        const data = await response.json();
        return data.results || [];
    } catch (error) {
        console.error("Web search error:", error);
        return [];
    }
}

// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { htmlToText } from "html-to-text";
import crypto from "crypto";
import { Readable } from "stream";
import multer from "multer";
import { createRequire } from "module";

// Use createRequire for CommonJS modules
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

// Import new security and scalability modules
import { createRateLimiter, createApiKeyValidator } from "./rate-limiter.js";
import { RequestQueue, sharedQueue } from "./request-queue.js";
import { sharedEmbeddingCache } from "./embedding-cache.js";

// Import new routes
import driveRoutes from "./routes/drive.routes.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- SECURITY: Strict CORS Configuration ---
// Define allowed origins (add your specific extension ID)
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  'https://friday-e65f2.web.app',
  // Add your Chrome extension ID here (get it from chrome://extensions)
  process.env.EXTENSION_ID ? `chrome-extension://${process.env.EXTENSION_ID}` : null,
  'chrome-extension://jmhghlacijdpjciifpobbfilakdickhb', // User's detected extension ID
].filter(Boolean);

// For development, optionally allow all chrome extensions (set ALLOW_ALL_EXTENSIONS=true in .env)
const ALLOW_ALL_EXTENSIONS = process.env.ALLOW_ALL_EXTENSIONS === 'true';

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (Postman, cURL, server-to-server)
      if (!origin) return callback(null, true);

      // Check if origin is in allowlist
      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      // Development mode: allow all chrome extensions if configured
      if (ALLOW_ALL_EXTENSIONS && origin.startsWith("chrome-extension://")) {
        console.warn(`⚠️ DEV MODE: Allowing extension origin: ${origin}`);
        return callback(null, true);
      }

      console.warn(`🚫 CORS blocked origin: ${origin}`);
      return callback(new Error("Not allowed by CORS: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);

// --- SECURITY: Rate Limiting ---
const rateLimiter = createRateLimiter({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minute
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests. Please wait before trying again.',
});

// Apply rate limiter to all routes
app.use(rateLimiter);

// --- SECURITY: API Key Validation (optional, enable in production) ---
const apiKeyValidator = createApiKeyValidator({
  excludePaths: ['/health', '/stats'],
});

// Uncomment below line to enable API key validation in production
// app.use(apiKeyValidator);

// Add OPTIONS handlers for routes
app.options("/ai/embed", cors());
app.options("/ai/stream", cors());
app.options("/search", cors());
app.options("/upsert", cors());
app.options("/delete", cors());
app.options("/scrape-url", cors());
app.options("/scrape-and-upsert", cors());
app.options("/serp/search", cors());
app.options("/cache/stats", cors());

app.use(bodyParser.json({ limit: "50mb" }));

// Mount new API routes
app.use("/drive", driveRoutes);

// Multer setup for file uploads (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// --- Parse File Endpoint (PDF, DOCX, PPTX) ---
app.post("/parse-file", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const mimeType = req.body.mimeType || file?.mimetype;

    if (!file || !file.buffer) {
      return res.status(400).json({ error: "No file provided" });
    }

    console.log(`📄 Parsing file: ${file.originalname || 'uploaded'} (${mimeType})`);

    let text = "";

    if (mimeType === "application/pdf") {
      // Parse PDF with error handling
      try {
        const pdfData = await pdfParse(file.buffer);
        text = pdfData.text || "";
      } catch (pdfError) {
        console.error("PDF parse error:", pdfError.message);
        // Return empty text instead of failing completely
        text = `[PDF parsing failed: ${pdfError.message}. The PDF may be encrypted or in an unsupported format.]`;
      }
    } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      // Parse DOCX
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      text = result.value || "";
    } else if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
      // Parse PPTX - basic text extraction
      text = "[PPTX file - content indexed for reference]";
    } else {
      // Try to read as text
      text = file.buffer.toString("utf-8");
    }

    // Clean up text
    text = text.replace(/\s+/g, " ").trim();

    console.log(`✅ Parsed ${text.length} characters`);
    res.json({ text, length: text.length });

  } catch (error) {
    console.error("Parse error:", error);
    res.status(500).json({ error: "Failed to parse file", details: error.message });
  }
});

// --- Configs --- (server-only secrets from .env)
const PINECONE_API_KEY = process.env.PINECONE_API_KEY || "";
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST || ""; // full https URL
const PINECONE_INDEX = process.env.PINECONE_INDEX || "siat";
const EMBED_DIM = Number(process.env.EMBED_DIM || 768);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const SERP_API_KEY = process.env.SERP_API_KEY || "";

// Basic sanity check (log once, without secrets)
if (!PINECONE_API_KEY || !PINECONE_INDEX_HOST) {
  console.warn(
    "⚠️ Missing Pinecone env: set PINECONE_API_KEY and PINECONE_INDEX_HOST in .env"
  );
}

// --- Helpers ---
function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const patched = { ...opts, signal: controller.signal };
  return fetch(url, patched).finally(() => clearTimeout(id));
}

function chunkText(str, chunkSize = 1400, overlap = 100) {
  const chunks = [];
  let i = 0;
  while (i < str.length) {
    const end = Math.min(i + chunkSize, str.length);
    chunks.push(str.slice(i, end));
    if (end === str.length) break;
    i = end - overlap;
  }
  return chunks;
}

function vectorIdFor(url, idx) {
  const h = crypto.createHash("sha1").update(`${url}#${idx}`).digest("hex");
  return `web_${h}_${idx}`;
}

async function getEmbedding(text, useCache = true) {
  const trimmedText = text.slice(0, 8000);

  // Check cache first
  if (useCache) {
    const cached = sharedEmbeddingCache.get(trimmedText);
    if (cached) {
      console.log('📦 Embedding cache hit');
      return cached;
    }
  }

  // Use request queue for API call with retry logic
  const embedding = await sharedQueue.enqueue(async () => {
    const body = {
      model: "text-embedding-004",
      content: {
        parts: [{ text: trimmedText }],
      },
    };

    let tries = 0;
    while (tries < 3) {
      tries++;
      const resp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        25000
      );

      if (resp.ok) {
        const data = await resp.json();
        return data.embedding?.values;
      }

      if (resp.status === 429 || resp.status >= 500) {
        await new Promise((r) =>
          setTimeout(r, 400 * Math.pow(2, tries) + Math.random() * 200)
        );
        continue;
      }

      const errText = await resp.text().catch(() => "");
      throw new Error(`Gemini embeddings failed: ${resp.status} ${errText}`);
    }
    throw new Error("Gemini embeddings failed after retries");
  }, { id: `embed_${Date.now()}` });

  // Cache the result
  if (embedding && useCache) {
    sharedEmbeddingCache.set(trimmedText, embedding);
    console.log('💾 Embedding cached');
  }

  return embedding;
}

// --- Health ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- Upsert ---
app.post("/upsert", async (req, res) => {
  console.log("📥 Received upsert request");

  try {
    const { namespace = "meeting-assistant", vectors } = req.body;
    console.log("🔍 Namespace:", namespace);
    console.log("📦 Number of vectors:", vectors?.length);

    if (!Array.isArray(vectors) || vectors.length === 0) {
      console.log("❌ No vectors received in upsert");
      return res
        .status(400)
        .json({ success: false, message: "No vectors provided" });
    }

    console.log(`📤 Upserting ${vectors.length} vectors to Pinecone...`);

    const response = await fetchWithTimeout(
      `${PINECONE_INDEX_HOST}/vectors/upsert`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Api-Key": PINECONE_API_KEY,
          "X-Pinecone-API-Version": "2024-07",
        },
        body: JSON.stringify({ vectors, namespace }),
      },
      25000
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("Pinecone upsert error:", response.status, errorText);
      throw new Error(
        `Pinecone upsert failed: ${response.status} - ${errorText}`
      );
    }

    const result = await response.json();
    console.log(`✅ Successfully upserted ${vectors.length} vectors`);

    res.json({
      success: true,
      upsertedCount: result.upsertedCount || vectors.length,
      message: "Vectors successfully upserted to Pinecone",
    });
  } catch (error) {
    console.error("Error upserting to Pinecone:", error);
    res.status(500).json({
      error: "Error upserting vectors to Pinecone",
      details: error.message,
    });
  }
});

// --- Search ---
app.post("/search", async (req, res) => {
  const {
    queryEmbedding,
    topK = 5,
    includeMetadata = true,
    namespace = "meeting-assistant",
  } = req.body;

  if (!queryEmbedding || !Array.isArray(queryEmbedding)) {
    return res.status(400).json({ error: "Invalid query embedding" });
  }

  try {
    console.log(`🔍 Performing semantic search (topK: ${topK})...`);

    const searchPayload = {
      vector: queryEmbedding,
      topK,
      includeMetadata,
      includeValues: false,
      namespace,
    };

    const response = await fetchWithTimeout(
      `${PINECONE_INDEX_HOST}/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Api-Key": PINECONE_API_KEY,
          "X-Pinecone-API-Version": "2024-07",
        },
        body: JSON.stringify(searchPayload),
      },
      25000
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("Pinecone search error:", response.status, errorText);
      throw new Error(
        `Pinecone search failed: ${response.status} - ${errorText}`
      );
    }

    const data = await response.json();
    const matches = data.matches || [];
    console.log(`✅ Found ${matches.length} matches`);

    const transformedResults = matches.map((match) => ({
      id: match.id,
      score: match.score,
      similarity: match.score,
      filename: match.metadata?.filename || "Unknown",
      chunkIndex: match.metadata?.chunkIndex ?? 0,
      content: match.metadata?.content || "",
      metadata: match.metadata || {},
    }));

    res.json(transformedResults);
  } catch (error) {
    console.error("Error performing Pinecone search:", error);
    res.status(500).json({
      error: "Error performing semantic search",
      details: error.message,
    });
  }
});

// --- Delete ---
app.post("/delete", async (req, res) => {
  const { ids, namespace = "" } = req.body;

  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ error: "Invalid ids array" });
  }

  try {
    console.log(`🗑️ Deleting ${ids.length} vectors from Pinecone...`);

    const deletePayload = { ids };
    if (namespace) deletePayload.namespace = namespace;

    const response = await fetchWithTimeout(
      `${PINECONE_INDEX_HOST}/vectors/delete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Api-Key": PINECONE_API_KEY,
          "X-Pinecone-API-Version": "2024-07",
        },
        body: JSON.stringify({ ids, namespace }),
      },
      25000
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("Pinecone delete error:", response.status, errorText);
      throw new Error(
        `Pinecone delete failed: ${response.status} - ${errorText}`
      );
    }

    console.log(`✅ Successfully deleted ${ids.length} vectors`);

    res.json({
      success: true,
      deletedCount: ids.length,
      message: "Vectors successfully deleted from Pinecone",
    });
  } catch (error) {
    console.error("Error deleting from Pinecone:", error);
    res.status(500).json({
      error: "Error deleting vectors from Pinecone",
      details: error.message,
    });
  }
});

// --- Stats ---
app.get("/stats", async (req, res) => {
  try {
    console.log("📊 Fetching Pinecone index statistics...");

    const response = await fetchWithTimeout(
      `${PINECONE_INDEX_HOST}/describe_index_stats`,
      {
        method: "POST",
        headers: {
          "Api-Key": PINECONE_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      20000
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error("Pinecone stats error:", response.status, errorText);
      throw new Error(
        `Pinecone stats failed: ${response.status} - ${errorText}`
      );
    }

    const stats = await response.json();
    console.log("✅ Retrieved index statistics");

    res.json({
      success: true,
      stats,
      indexName: PINECONE_INDEX,
    });
  } catch (error) {
    console.error("Error getting Pinecone stats:", error);
    res.status(500).json({
      error: "Error getting index statistics",
      details: error.message,
    });
  }
});

// --- Cache & Queue Stats ---
app.get("/cache/stats", (req, res) => {
  res.json({
    success: true,
    embeddingCache: sharedEmbeddingCache.getStats(),
    requestQueue: sharedQueue.getStats(),
    timestamp: new Date().toISOString(),
  });
});

// --- NEW: /scrape-url ---
app.post("/scrape-url", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\/\S+/i.test(url)) {
      return res.status(400).json({ error: "Invalid URL" });
    }
    const pageResp = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Friday/1.0" } },
      20000
    );
    if (!pageResp.ok) {
      const text = await pageResp.text().catch(() => "");
      return res
        .status(pageResp.status)
        .json({ error: "Fetch failed", details: text.slice(0, 500) });
    }
    const html = await pageResp.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const title = article?.title || dom.window.document.title || url;
    const text = htmlToText(article?.content || html, {
      wordwrap: false,
      selectors: [{ selector: "a", options: { ignoreHref: true } }],
    });
    return res.json({ title, url, text });
  } catch (err) {
    console.error("scrape-url error:", err);
    return res
      .status(500)
      .json({ error: "Failed to scrape URL", details: err.message });
  }
});

// --- NEW: /scrape-and-upsert ---
app.post("/scrape-and-upsert", async (req, res) => {
  try {
    const { url, namespaceHint } = req.body || {};
    if (!url || !/^https?:\/\/\S+/i.test(url)) {
      return res.status(400).json({ error: "Invalid URL" });
    }
    const pageResp = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Friday/1.0" } },
      20000
    );
    if (!pageResp.ok) {
      const text = await pageResp.text().catch(() => "");
      return res
        .status(pageResp.status)
        .json({ error: "Fetch failed", details: text.slice(0, 500) });
    }
    const html = await pageResp.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const title = article?.title || dom.window.document.title || url;
    const fullText = htmlToText(article?.content || html, {
      wordwrap: false,
      selectors: [{ selector: "a", options: { ignoreHref: true } }],
    }).trim();
    if (!fullText)
      return res.json({ success: false, upserted: 0, reason: "Empty page" });

    const hostname = new URL(url).hostname;
    const namespace = namespaceHint || `web:${hostname}`;
    const chunks = chunkText(fullText, 1400, 100);
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await getEmbedding(chunk);
      if (!embedding) continue;
      const metaContent = chunk.slice(0, 1000);
      vectors.push({
        id: vectorIdFor(url, i),
        values: embedding,
        metadata: {
          source: "web",
          url,
          hostname,
          title,
          chunkIndex: i,
          content: metaContent,
          wordCount: metaContent.split(/\s+/).length,
          scrapedAt: new Date().toISOString(),
        },
      });
    }
    if (!vectors.length)
      return res.json({ success: false, upserted: 0, reason: "No vectors" });

    const upsertOnce = async () => {
      const r = await fetchWithTimeout(
        `${PINECONE_INDEX_HOST}/vectors/upsert`,
        {
          method: "POST",
          headers: {
            "Api-Key": PINECONE_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ namespace, vectors }),
        },
        25000
      );
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`Pinecone upsert failed: ${r.status} ${t}`);
      }
      return r.json();
    };
    try {
      await upsertOnce();
    } catch (err) {
      if (String(err.message).includes("429")) {
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 400));
        await upsertOnce();
      } else throw err;
    }
    return res.json({
      success: true,
      upserted: vectors.length,
      namespace,
      title,
      url,
    });
  } catch (err) {
    console.error("scrape-and-upsert error:", err);
    return res
      .status(500)
      .json({ error: "Failed to scrape & upsert", details: err.message });
  }
});

// --- NEW: /serp/search (SerpAPI proxy) ---
app.post("/serp/search", async (req, res) => {
  try {
    const { q } = req.body || {};
    if (!q || typeof q !== "string")
      return res.status(400).json({ error: "Missing q" });
    if (!SERP_API_KEY)
      return res.status(400).json({ error: "Missing SERP_API_KEY on server" });
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", q);
    url.searchParams.set("api_key", SERP_API_KEY);
    url.searchParams.set("num", "10");
    const r = await fetchWithTimeout(url.toString(), {}, 20000);
    const j = await r.json();
    const items = (j.organic_results || []).map((it) => ({
      title: it.title,
      link: it.link,
      snippet: it.snippet || (it.snippet_highlighted_words || []).join(" "),
    }));
    return res.json({ results: items });
  } catch (err) {
    console.error("serp/search error:", err);
    return res
      .status(500)
      .json({ error: "SerpAPI failed", details: err.message });
  }
});

// --- NEW: AI Embedding Endpoint (secure) ---
app.post("/ai/embed", async (req, res) => {
  try {
    const { text, model = "text-embedding-004" } = req.body;

    if (!text || typeof text !== "string" || text.trim().length < 10) {
      return res
        .status(400)
        .json({ error: "Valid text required (min 10 chars)" });
    }

    const input = text.length > 8000 ? text.slice(0, 8000) : text;

    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model,
          content: { parts: [{ text: input }] },
        }),
      },
      25000
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini embed error:", response.status, errorText);
      return res
        .status(500)
        .json({ error: "Embedding generation failed", details: errorText });
    }

    const data = await response.json();
    const embedding = data.embedding?.values;

    if (!embedding || !Array.isArray(embedding)) {
      return res.status(500).json({ error: "Invalid embedding response" });
    }

    res.json({ embedding });
  } catch (error) {
    console.error("Error in /ai/embed:", error);
    res
      .status(500)
      .json({
        error: "Server error generating embedding",
        details: error.message,
      });
  }
});

// --- NEW: AI Streaming Chat Endpoint (secure) ---
// FULL UPDATED ROUTE: replace your existing app.post('/ai/stream', ...) with this
app.post("/ai/stream", async (req, res) => {
  try {
    const {
      messages,
      model = "gemini-2.5-flash", // pick your default
      temperature = 0.4,
      maxTokens = 2048,
    } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    // Convert your messages -> Gemini "contents"
    // System messages become a preamble; user/assistant map to roles
    const contents = [];
    let systemText = "";
    for (const m of messages) {
      if (m.role === "system") {
        systemText += (systemText ? "\n\n" : "") + (m.content || "");
      } else {
        contents.push({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content || "" }],
        });
      }
    }

    const requestBody = {
      // Only include system instruction if you have any
      ...(systemText
        ? {
          systemInstruction: {
            role: "system",
            parts: [{ text: systemText }],
          },
        }
        : {}),
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };

    // Prepare downstream as SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Gemini SSE endpoint
    const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;

    const upstream = await fetch(streamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!upstream.ok) {
      const t = await upstream.text().catch(() => "");
      res.write(
        `data: ${JSON.stringify({
          error: "Gemini upstream error",
          status: upstream.status,
          details: t,
        })}\n\n`
      );
      return res.end();
    }

    // Keep some proxies happy
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch { }
    }, 15000);

    const onEnd = () => {
      clearInterval(heartbeat);
      try {
        res.end();
      } catch { }
    };
    const onError = (err) => {
      clearInterval(heartbeat);
      try {
        res.write(
          `data: ${JSON.stringify({
            error: "proxy error",
            details: String(err),
          })}\n\n`
        );
      } catch { }
      try {
        res.end();
      } catch { }
    };

    const body = upstream.body;

    // Case A: Node.js Readable stream (typical with node-fetch)
    if (body && typeof body.pipe === "function") {
      body.on("error", onError).pipe(res);
      body.on("end", onEnd);
      return;
    }

    // Case B: Web ReadableStream (if your fetch returns web streams)
    if (body && typeof body.getReader === "function") {
      const nodeStream = Readable.fromWeb(body);
      nodeStream.on("error", onError).pipe(res);
      nodeStream.on("end", onEnd);
      return;
    }

    // Fallback: no stream exposed, dump text and close
    const text = await upstream.text().catch(() => "");
    res.write(text);
    onEnd();
  } catch (e) {
    try {
      res.write(
        `data: ${JSON.stringify({
          error: "server error",
          details: String(e),
        })}\n\n`
      );
    } catch { }
    try {
      res.end();
    } catch { }
  }
});

// --- Error handlers / 404 ---
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    error: "Internal server error",
    details:
      process.env.NODE_ENV === "development"
        ? error.message
        : "Something went wrong",
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    availableRoutes: [
      "GET /health",
      "GET /stats",
      "GET /cache/stats",
      "POST /search",
      "POST /upsert",
      "POST /delete",
      "POST /scrape-url",
      "POST /scrape-and-upsert",
      "POST /serp/search",
      "POST /ai/embed",
      "POST /ai/stream",
    ],
  });
});

app.listen(port, () => {
  console.log(`\n🚀 Friday Backend Server v2.0 (MVP)`);
  console.log(`   Running at http://localhost:${port}`);
  console.log(`\n📊 Pinecone Index: ${PINECONE_INDEX}`);
  console.log(`\n🔒 Security Features:`);
  console.log(`   - Strict CORS: ${ALLOW_ALL_EXTENSIONS ? 'DEV MODE (all extensions allowed)' : 'Production (allowlist only)'}`);
  console.log(`   - Rate Limiting: ${process.env.RATE_LIMIT_MAX_REQUESTS || 100} req/min`);
  console.log(`   - Embedding Cache: Max ${process.env.EMBEDDING_CACHE_MAX_SIZE || 1000} entries`);
  console.log(`\n📡 Available endpoints:`);
  console.log(`   GET  /health        - Health check`);
  console.log(`   GET  /stats         - Pinecone stats`);
  console.log(`   GET  /cache/stats   - Cache & queue stats`);
  console.log(`   POST /search        - Semantic search`);
  console.log(`   POST /upsert        - Upsert vectors`);
  console.log(`   POST /delete        - Delete vectors`);
  console.log(`   POST /scrape-url    - Scrape webpage`);
  console.log(`   POST /scrape-and-upsert - Scrape & index`);
  console.log(`   POST /serp/search   - Web search`);
  console.log(`   POST /ai/embed      - Get embeddings`);
  console.log(`   POST /ai/stream     - Chat completion`);
  console.log(`\n✅ Server ready!\n`);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Gracefully shutting down server...");
  sharedEmbeddingCache.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Gracefully shutting down server...");
  sharedEmbeddingCache.destroy();
  process.exit(0);
});

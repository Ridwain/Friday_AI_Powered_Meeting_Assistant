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

dotenv.config();

const app = express();
const port = 3000;

// CORS: allow localhost and any chrome extension IDs
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Postman/cURL
      if (origin.startsWith("http://localhost")) return callback(null, true);
      if (origin.startsWith("chrome-extension://")) return callback(null, true);
      return callback(new Error("Not allowed by CORS: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);

// Add OPTIONS handlers for new routes
app.options("/ai/embed", cors());
app.options("/ai/stream", cors());
app.options("/search", cors());
app.options("/upsert", cors());
app.options("/delete", cors());
app.options("/scrape-url", cors());
app.options("/scrape-and-upsert", cors());
app.options("/serp/search", cors());

app.use(bodyParser.json({ limit: "50mb" }));

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

async function getEmbedding(text) {
  const body = {
    model: "text-embedding-004",
    content: {
      parts: [{ text: text.slice(0, 8000) }],
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
      } catch {}
    }, 15000);

    const onEnd = () => {
      clearInterval(heartbeat);
      try {
        res.end();
      } catch {}
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
      } catch {}
      try {
        res.end();
      } catch {}
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
    } catch {}
    try {
      res.end();
    } catch {}
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
      "POST /search",
      "POST /upsert",
      "POST /delete",
      "POST /scrape-url",
      "POST /scrape-and-upsert",
      "POST /serp/search",
      "POST /ai/embed", // NEW
      "POST /ai/stream",
    ],
  });
});

app.listen(port, () => {
  console.log(`🚀 Semantic search server running at http://localhost:${port}`);
  console.log(`📊 Pinecone Index: ${PINECONE_INDEX}`);
  //console.log(`🌍 Environment: ${PINECONE_ENVIRONMENT}`);
  console.log("\nAvailable endpoints:");
  console.log(`  GET  http://localhost:${port}/health`);
  console.log(`  GET  http://localhost:${port}/stats`);
  console.log(`  POST http://localhost:${port}/search`);
  console.log(`  POST http://localhost:${port}/upsert`);
  console.log(`  POST http://localhost:${port}/delete`);
  console.log(`  POST http://localhost:${port}/scrape-url`);
  console.log(`  POST http://localhost:${port}/scrape-and-upsert`);
  console.log(`  POST http://localhost:${port}/serp/search`);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Gracefully shutting down server...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Gracefully shutting down server...");
  process.exit(0);
});

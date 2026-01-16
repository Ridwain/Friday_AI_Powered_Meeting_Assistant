import { CONFIG } from "./config.js";

// Lazy Load Variables
let db;
let collection, addDoc, serverTimestamp, query, orderBy, getDocs, getDoc, doc, setDoc, updateDoc;
let initWebScraper, isUrlLike, scrapeUrl, scrapeAndUpsert, serpSearch, detectWebSearchyQuery, indexUrlsFromFiles, buildMessagesForUrlQA;
let getAIResponse;

async function loadDependencies() {
  if (db) return;
  const [fbConfig, fbFirestore, webScraper, aiHelper] = await Promise.all([
    import("./firebase-config.js"),
    import("./firebase/firebase-firestore.js"),
    import("./web-scraper.js"),
    import("./enhanced-ai-helper.js")
  ]);

  db = fbConfig.db;

  ({ collection, addDoc, serverTimestamp, query, orderBy, getDocs, getDoc, doc, setDoc, updateDoc } = fbFirestore);
  ({ initWebScraper, isUrlLike, scrapeUrl, scrapeAndUpsert, serpSearch, detectWebSearchyQuery, indexUrlsFromFiles, buildMessagesForUrlQA } = webScraper);
  ({ getAIResponse } = aiHelper);
}

// Typewriter CSS is now inline in chat.html for faster load

// rAF throttle so we don't spam layout
function rafThrottle(fn) {
  let scheduled = false;
  return (...args) => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        fn(...args);
      } catch { }
    });
  };
}

function makeTypewriter(targetEl, { wps = 9, onTick } = {}) {
  const interval = 1000 / Math.max(1, wps); // words/sec
  const tickScroll = rafThrottle(() => {
    try {
      // ✅ call your actual helper that scrolls #chatMessages
      scrollToBottom(true);
    } catch {
      // fallback in case scope changes
      const pane =
        document.getElementById("chatMessages") ||
        document.querySelector(
          ".chat-messages, .messages, #chat, .conversation, .scrollable"
        );
      if (pane) pane.scrollTop = pane.scrollHeight;
      else
        window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
    }
    if (typeof onTick === "function") onTick();
  });

  let carry = "";
  let queue = [];
  let running = false;
  let rafId = null;
  let lastTs = 0;

  targetEl.classList.add("typing");
  targetEl.textContent = "";

  function tick(ts) {
    if (!running) return;
    if (ts - lastTs >= interval && queue.length) {
      lastTs = ts;
      const word = queue.shift();
      if (targetEl.textContent.length === 0) targetEl.textContent = word;
      else targetEl.textContent += " " + word;
      tickScroll(); // 👈 scroll as we print
    }
    if (queue.length || carry) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = requestAnimationFrame(tick);
    }
  }

  return {
    onToken: (t = "") => {
      const s = carry + t;
      const parts = s.split(/\s+/);
      if (/\s$/.test(s)) carry = "";
      else carry = parts.pop() || "";
      for (const w of parts) if (w) queue.push(w);
      if (!running) {
        running = true;
        requestAnimationFrame(tick);
      }
    },
    async finish(finalText, { postProcess } = {}) {
      if (carry) {
        queue.push(carry);
        carry = "";
      }
      await new Promise((resolve) => {
        const check = () => {
          if (queue.length === 0) return resolve();
          requestAnimationFrame(check);
        };
        check();
      });
      if (rafId) cancelAnimationFrame(rafId);
      targetEl.classList.remove("typing");
      targetEl.innerHTML =
        typeof linkify === "function" ? linkify(finalText) : finalText;
      // one last scroll to ensure the linkified content is in view
      tickScroll();
      if (typeof postProcess === "function") postProcess();
    },
  };
}
// --- end typewriter helper ---

const RAG_CONFIG = {
  SERVER_URL: CONFIG.SERVER_URL,
  MAX_RESULTS: CONFIG.RAG.MAX_RESULTS,
  SIMILARITY_THRESHOLD: CONFIG.RAG.SIMILARITY_THRESHOLD,
};
// latency knobs
const SEARCH_TIMEOUT_MS = CONFIG.RAG.SEARCH_TIMEOUT_MS;
const FAST_HIT_THRESHOLD = CONFIG.RAG.FAST_HIT_THRESHOLD;

let conversationHistory = [];
const MAX_CONVERSATION_HISTORY = 10;
const UPLOAD_TRACKER_KEY = "ragUploadedFilesV2";
// Map: { [fileId]: modifiedTimeString }
let uploadedFiles = {};

async function loadUploadedFilesList() {
  const result = await chrome.storage.local.get(UPLOAD_TRACKER_KEY);
  if (result[UPLOAD_TRACKER_KEY]) {
    uploadedFiles = result[UPLOAD_TRACKER_KEY];
    console.log(
      `📦 Using cached file list with ${Object.keys(uploadedFiles).length
      } entries`
    );
  } else {
    uploadedFiles = {};
    console.log("📦 No cached file list found");
  }
}

async function saveUploadedFilesList() {
  await chrome.storage.local.set({ [UPLOAD_TRACKER_KEY]: uploadedFiles });
  console.log(
    `✅ Updated cached file list with ${Object.keys(uploadedFiles).length
    } entries`
  );
}

function normalizeFilename(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\w\s.-]/g, "");
}


document.addEventListener("DOMContentLoaded", async () => {
  // Main chat interface code - DECLARE VARIABLES FIRST
  let chatMessages = document.getElementById("chatMessages");
  let chatInput = document.getElementById("chatInput");
  let micBtn = document.getElementById("micBtn");
  let voiceReplyToggle = document.getElementById("voiceReplyToggle");
  let sendBtn = document.getElementById("sendBtn");

  let synth = window.speechSynthesis;
  let recognition;
  let isMicActive = false;
  let selectedMeeting = null;
  let userUid = null;
  let isProcessing = false;
  const filesContentMap = {};

  // 🚀 FAST PATH: Load data immediately - PARALLEL storage reads
  // This ensures UI feels instant even if other components take time
  try {
    // Remove loading skeleton as soon as JS runs
    const skeleton = document.getElementById("loadingSkeleton");

    const result = await chrome.storage.local.get(["selectedMeetingForChat", "uid", "chatSessionActive"]);
    if (result.selectedMeetingForChat && result.uid) {
      selectedMeeting = result.selectedMeetingForChat;
      userUid = result.uid;

      if (selectedMeeting.meetingId && result.chatSessionActive === true) {
        console.log("🚀 Starting fast chat load...");
        loadChatHistory(userUid, selectedMeeting.meetingId);
      } else {
        showWelcomeState();
      }
    } else {
      showWelcomeState();
    }

    // Remove skeleton after initial state is determined
    if (skeleton) skeleton.remove();
  } catch (e) {
    console.error("Fast load error:", e);
    const skeleton = document.getElementById("loadingSkeleton");
    if (skeleton) skeleton.remove();
  }

  // Helper to append a message to the UI
  function appendMessage(role, content, timestamp) {
    const chatContainer = document.getElementById("chatMessages");
    if (!chatContainer) return;

    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role === "user" ? "user-bubble" : "ai-bubble"}`;
    bubble.innerHTML = linkify(content);

    // Add timestamp tooltip if available
    if (timestamp) {
      bubble.title = new Date(timestamp).toLocaleString();
    }

    chatContainer.appendChild(bubble);
  }

  // Helper to scroll chat container to bottom
  function scrollToBottom(smooth = true) {
    const chatContainer = document.getElementById("chatMessages");
    if (!chatContainer) return;

    // Immediate scroll
    chatContainer.scrollTop = chatContainer.scrollHeight;

    // Ensure it happens after paint (for images/rendering lag)
    requestAnimationFrame(() => {
      chatContainer.scrollTop = chatContainer.scrollHeight;
      setTimeout(() => {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }, 50);
    });
  }

  // Performance constants
  const MAX_VISIBLE_MESSAGES = 50;  // Only render last 50 in DOM
  const MAX_CACHED_MESSAGES = 200;  // Limit cache size
  let allMessages = []; // Full history for "load more"
  let visibleStartIndex = 0; // Track where visible window starts

  async function loadChatHistory(uid, meetingId) {
    const chatContainer = document.getElementById("chatMessages");
    const CACHE_KEY = `chat_cache_${uid}_${meetingId}`;

    // Helper: Render messages using DocumentFragment (batch DOM update)
    function renderMessages(messages, prepend = false) {
      const fragment = document.createDocumentFragment();

      messages.forEach(msg => {
        const bubble = document.createElement("div");
        bubble.className = `chat-bubble ${msg.role === "user" ? "user-bubble" : "ai-bubble"}`;
        bubble.innerHTML = linkify(msg.content);
        if (msg.timestamp) {
          bubble.title = new Date(msg.timestamp).toLocaleString();
        }
        fragment.appendChild(bubble);
      });

      if (prepend && chatContainer.firstChild) {
        chatContainer.insertBefore(fragment, chatContainer.firstChild);
      } else {
        chatContainer.appendChild(fragment);
      }
    }

    // Helper: Add "Load Earlier Messages" button
    function addLoadMoreButton() {
      // Remove existing button if any
      const existing = chatContainer.querySelector(".load-more-btn");
      if (existing) existing.remove();

      if (visibleStartIndex <= 0) return; // No more to load

      const btn = document.createElement("button");
      btn.className = "load-more-btn";
      btn.textContent = `Load ${Math.min(MAX_VISIBLE_MESSAGES, visibleStartIndex)} earlier messages`;
      btn.style.cssText = "width:100%;padding:10px;margin-bottom:10px;background:#f0f0f0;border:1px solid #ccc;border-radius:8px;cursor:pointer;";
      btn.onclick = () => {
        const loadCount = Math.min(MAX_VISIBLE_MESSAGES, visibleStartIndex);
        const newStart = visibleStartIndex - loadCount;
        const olderMessages = allMessages.slice(newStart, visibleStartIndex);
        visibleStartIndex = newStart;

        // Remember scroll position
        const scrollHeight = chatContainer.scrollHeight;

        // Render older messages at top
        btn.remove();
        renderMessages(olderMessages, true);
        addLoadMoreButton();

        // Maintain scroll position
        chatContainer.scrollTop = chatContainer.scrollHeight - scrollHeight;
      };

      chatContainer.insertBefore(btn, chatContainer.firstChild);
    }

    // 1. Try to load from local cache IMMEDIATELY
    try {
      const cached = await chrome.storage.local.get(CACHE_KEY);
      if (cached[CACHE_KEY] && Array.isArray(cached[CACHE_KEY])) {
        console.log("⚡ Loaded chat history from cache");
        allMessages = cached[CACHE_KEY];
        conversationHistory = allMessages;

        // Only render LAST N messages for performance
        chatContainer.innerHTML = '';
        const messagesToShow = allMessages.slice(-MAX_VISIBLE_MESSAGES);
        visibleStartIndex = Math.max(0, allMessages.length - MAX_VISIBLE_MESSAGES);

        renderMessages(messagesToShow);
        addLoadMoreButton();
        scrollToBottom(false);
      }
    } catch (e) {
      console.warn("Cache load failed:", e);
    }

    // 2. Fetch fresh data from Firestore (background update)
    await loadDependencies();
    const chatRef = collection(db, "users", uid, "meetings", meetingId, "chats");
    const q = query(chatRef, orderBy("timestamp", "asc"));

    try {
      const snapshot = await getDocs(q);
      const freshHistory = [];

      snapshot.forEach((doc) => {
        const data = doc.data();
        freshHistory.push({
          role: data.role,
          content: data.content,
          timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : new Date().toISOString()
        });
      });

      allMessages = freshHistory;
      conversationHistory = freshHistory;

      // Render only last N messages
      chatContainer.innerHTML = '';
      const messagesToShow = freshHistory.slice(-MAX_VISIBLE_MESSAGES);
      visibleStartIndex = Math.max(0, freshHistory.length - MAX_VISIBLE_MESSAGES);

      renderMessages(messagesToShow);
      addLoadMoreButton();
      scrollToBottom(true);

      // Cache with size limit
      const cacheData = freshHistory.length > MAX_CACHED_MESSAGES
        ? freshHistory.slice(-MAX_CACHED_MESSAGES)
        : freshHistory;
      chrome.storage.local.set({ [CACHE_KEY]: cacheData });

      console.log(`✅ Loaded ${freshHistory.length} messages, displaying ${messagesToShow.length}`);

    } catch (err) {
      console.error("❌ Failed to load chat history:", err);
    }
  }

  // NOTE: Initial load is now handled above in the FAST PATH section
  // This listener only handles CHANGES after initial load

  // 🎧 LISTEN FOR STORAGE CHANGES (e.g. Back button clicked in dashboard)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      // Handle Activation Change (User clicked "Ask AI")
      if (changes.chatSessionActive) {
        if (changes.chatSessionActive.newValue === true) {
          // User just clicked "Ask AI" - Load the chat!
          console.log("🚀 Chat Activated by User");
          // Fetch latest meeting just in case
          chrome.storage.local.get(["selectedMeetingForChat", "uid"], (res) => {
            if (res.selectedMeetingForChat && res.uid) {
              selectedMeeting = res.selectedMeetingForChat;
              userUid = res.uid;
              loadChatHistory(userUid, selectedMeeting.meetingId);
            }
          });
        } else {
          // Deactivated (e.g. Back button)
          showWelcomeState();
        }
      }

      if (changes.selectedMeetingForChat) {
        const newValue = changes.selectedMeetingForChat.newValue;
        const oldValue = changes.selectedMeetingForChat.oldValue;

        if (!newValue) {
          // Meeting deslected (User clicked Back) -> Clear Chat
          console.log("👋 Meeting deselected, resetting chat...");
          selectedMeeting = null;
          chatMessages.innerHTML = "";
          showWelcomeState();
        } else if (newValue && newValue.meetingId !== selectedMeeting?.meetingId) {
          // New meeting selected - Only load if already active
          selectedMeeting = newValue;

          chrome.storage.local.get("chatSessionActive", (res) => {
            if (res.chatSessionActive === true) {
              console.log("🔄 New meeting selected & active, reloading chat...");
              chatMessages.innerHTML = "";
              if (userUid) loadChatHistory(userUid, selectedMeeting.meetingId);
            } else {
              console.log("🔄 New meeting selected but inactive. Waiting for user to click button.");
              showWelcomeState();
            }
          });
        }
      }

      // Also update UID if it changes (just in case)
      if (changes.uid) {
        userUid = changes.uid.newValue;
      }
    }
  });

  function showWelcomeState() {
    chatMessages.innerHTML = "";
    const welcomeDiv = document.createElement("div");
    welcomeDiv.className = "welcome-message";
    welcomeDiv.innerHTML = `
      <div class="welcome-icon-wrapper">
        <span class="welcome-icon">🤖</span>
      </div>
      <h3>Ready to Chat?</h3>
      <p>Please click the <strong>"Ask AI"</strong> button in the extension dashboard to start a conversation.</p>
    `;
    chatMessages.appendChild(welcomeDiv);
  }



  // Initialize Speech Recognition & Scraper in background
  (async () => {
    try {
      await loadDependencies();
      initWebScraper().catch(e => console.warn("web-scraper init failed:", e));
    } catch (e) { console.warn("init failed:", e); }
  })();

  // Function to load transcript
  async function loadTranscript(uid, meetingId) {
    try {
      const transcriptsRef = collection(
        db,
        "users",
        uid,
        "meetings",
        meetingId,
        "transcripts"
      );
      const snapshot = await getDocs(transcriptsRef);
      let transcriptContent = "";

      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.transcript) {
          transcriptContent += data.transcript + "\n";
        } else if (data.content) {
          transcriptContent += data.content + "\n";
        }
      });

      return transcriptContent.trim();
    } catch (error) {
      console.error("Error loading transcript:", error);
      return "Failed to load meeting transcript.";
    }
  }

  async function generateEmbedding(text) {
    // Guard: Server requires minimum 10 characters
    if (!text || text.trim().length < 10) {
      console.log("⏭️ Skipping embedding for short text");
      return null;
    }
    try {
      const response = await fetch(`${RAG_CONFIG.SERVER_URL}/ai/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.substring(0, 8000) }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Server embedding error: ${response.status} - ${errorData.error || "Unknown error"
          }`
        );
      }

      const data = await response.json();
      return data.embedding;
    } catch (error) {
      console.error("Error generating embedding:", error);
      return null;
    }
  }

  async function uploadChunksToPinecone(chunks, filename) {
    try {
      if (!chunks || chunks.length === 0) {
        console.warn("No chunks to upload for", filename);
        return;
      }

      console.log(
        `📤 Uploading ${chunks.length} chunks from ${filename} to Pinecone...`
      );

      const vectors = chunks.map((chunk) => ({
        id: chunk.id,
        values: chunk.embedding,
        metadata: {
          filename: chunk.filename,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content.substring(0, 1000),
          wordCount: chunk.content.split(/\s+/).length,
          uploadedAt: new Date().toISOString(),
        },
      }));

      const response = await fetch(`${RAG_CONFIG.SERVER_URL}/upsert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          namespace: "siat",
          vectors,
        }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Upload failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log(
        `✅ Successfully uploaded ${result.upsertedCount || vectors.length
        } vectors from ${filename}`
      );
      return result;
    } catch (error) {
      console.error(`❌ Failed to upload chunks from ${filename}:`, error);
    }
  }

  async function performRAGSearch(query, namespace) {
    try {
      const queryEmbedding = await generateEmbedding(query);
      if (!queryEmbedding)
        throw new Error("Failed to generate query embedding");

      // Build request body; include namespace only if provided
      const requestBody = {
        queryEmbedding,
        topK: RAG_CONFIG.MAX_RESULTS,
        includeMetadata: true,
      };
      if (namespace) {
        requestBody.namespace = namespace;
      }

      const response = await fetch(`${RAG_CONFIG.SERVER_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) throw new Error(`Search failed: ${response.status}`);
      const results = await response.json();
      return results;
    } catch (error) {
      console.error("RAG search error:", error);
      return [];
    }
  }

  // short-lived cache for embeddings (avoid duplicate OpenAI calls)
  const _embeddingMemo = new Map();
  // a single controller per user question; reused across parallel fetches
  let activeSearchAborter = null;

  function _memoKey(q) {
    return q.trim().toLowerCase().slice(0, 256);
  }

  function abortActiveSearch() {
    if (activeSearchAborter) {
      try {
        activeSearchAborter.abort();
      } catch { }
    }
  }

  // Compute the embedding once per user query (memoized for ~60s)
  async function getQueryEmbeddingOnce(query) {
    const key = _memoKey(query);
    const cached = _embeddingMemo.get(key);
    if (cached && performance.now() - cached.t < 60_000) {
      return cached.v;
    }
    const v = await generateEmbedding(query); // <-- your existing embedding fn
    if (v) _embeddingMemo.set(key, { v, t: performance.now() });
    return v;
  }

  // Simple timeout guard (so we can fall back cleanly)
  function withTimeout(promise, ms = 6000) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
    ]);
  }

  // Optimized search that REUSES a precomputed embedding
  // IMPORTANT: No internal abort logic here. We accept a shared `signal`.
  async function performRAGSearchWithEmbedding(
    queryEmbedding,
    namespace,
    opts = {}
  ) {
    if (!queryEmbedding) return [];
    const { signal } = opts;

    const body = {
      queryEmbedding,
      topK: RAG_CONFIG?.MAX_RESULTS || 5,
      includeMetadata: true,
      ...(namespace ? { namespace } : {}),
    };

    const res = await fetch(`${RAG_CONFIG.SERVER_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    return res.json();
  }

  // ==== RAG BRAIN: Anti-Copy Pipeline ====
  function extractKeywords(question, k = 10) {
    const terms =
      String(question || "")
        .toLowerCase()
        .match(/[a-z0-9]+/g) || [];
    const stop = new Set([
      "the",
      "is",
      "are",
      "a",
      "an",
      "of",
      "and",
      "in",
      "to",
      "about",
      "on",
      "for",
      "with",
      "who",
      "what",
      "when",
      "where",
      "why",
      "how",
      "tell",
      "me",
    ]);
    const freq = new Map();
    for (const t of terms)
      if (!stop.has(t)) freq.set(t, (freq.get(t) || 0) + 1);
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map((x) => x[0]);
  }

  function sentenceSplit(text) {
    return String(text || "")
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean);
  }

  function trimHitToQuestion(hit, question) {
    const raw = hit?.content || hit?.metadata?.text || hit?.text || "";
    if (!raw) return null;
    const keywords = extractKeywords(question, 12);
    const sents = sentenceSplit(raw);
    const scored = sents.map((s) => {
      const ls = s.toLowerCase();
      let score = 0;
      for (const kw of keywords) if (ls.includes(kw)) score++;
      return { s, score };
    });
    const kept = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(2, Math.min(6, scored.length)))
      .map((x) => x.s);
    const text = kept.join(" ");
    return text ? { ...hit, text } : null;
  }

  function dedupHits(hits) {
    const seen = new Set();
    const out = [];
    for (const h of hits) {
      const key =
        (h.metadata?.filename || h.filename || h.source || "unknown") +
        "|" +
        (h.text || h.content || "").slice(0, 160);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(h);
      }
    }
    return out;
  }

  function tagBestSnippets(hits, max = 12) {
    if (!Array.isArray(hits)) return [];
    // ensure we keep only unique, best-scoring snippets
    const deduped = dedupHits(hits).sort(
      (a, b) => (b.score || 0) - (a.score || 0)
    );
    return deduped.slice(0, Math.min(max, deduped.length)).map((h, i) => ({
      tag: `T${i + 1}`,
      text: h.text || h.content || h?.metadata?.text || "",
      source: h.source || h?.metadata?.filename || h.filename || "Document",
      score: h.score ?? h.similarity ?? 0,
    }));
  }

  async function compressSnippetsWithLLM(question, taggedSnips, getAIResponse) {
    const content = [
      {
        role: "system",
        content: `You are a careful research assistant. Read the tagged snippets and extract only statements that directly answer the question.
Rules:
- Write 5–8 concise bullets in your own words (no long quotes).
- Preserve important numbers/dates/names.
- Each bullet must include the tag(s) you used, e.g., [#T2] or [#T1][#T4].
- If snippets contradict, mention the discrepancy briefly.`,
      },
      {
        role: "user",
        content: `Question: ${question}

Tagged snippets:
${taggedSnips
            .map((s) => `[#${s.tag}] ${s.text}\n— source: ${s.source}`)
            .join("\n\n")}

Return ONLY the bullet points.`,
      },
    ];
    const summary = await getAIResponse(content);
    return summary;
  }
  const FHT =
    typeof FAST_HIT_THRESHOLD === "number" ? FAST_HIT_THRESHOLD : 0.88;

  async function getGroundedAnswer(userQuestion, rawMatches, getAIResponse) {
    const hits = (rawMatches || [])
      .filter((h) => h && (h.content || h.metadata?.text || h.text))
      .map((h, i) => ({
        id: h.id || `H${i + 1}`,
        score: h.score ?? h.similarity ?? 0,
        source: h.metadata?.filename || h.filename || h.source || "Document",
        text: h.content || h.metadata?.text || h.text,
      }))
      .map((h) => trimHitToQuestion(h, userQuestion))
      .filter(Boolean);

    // short-circuit: if we have one super-strong hit, answer from that only
    const best = hits.reduce(
      (a, b) => (b.score > (a?.score ?? -1) ? b : a),
      null
    );
    const chosen = best && best.score >= FHT ? [best] : hits;

    // clip each snippet to keep the prompt lean
    const snippet = (t, n = 450) => (t.length > n ? t.slice(0, n) + "…" : t);
    const tagged = tagBestSnippets(chosen);
    const packed = tagged
      .map((s) => `[#${s.tag}] ${snippet(s.text)} — ${s.source}`)
      .join("\n\n");

    const prompt = [
      {
        role: "system",
        content: `You are a precise assistant. Answer ONLY from the tagged snippets.
- Keep it concise .
- Do NOT include any citations, tags, or bracketed references like [#T1] or [#T1, #T2].
- If snippets conflict, resolve quietly; do not mention tags.`,
      },
      {
        role: "user",
        content: `Question: ${userQuestion}

Tagged snippets:
${packed}

Answer:`,
      },
    ];

    const answer = await getAIResponse(prompt);
    return { answer, hasEvidence: tagged.length > 0, sources: tagged };
  }
  // ==== END RAG BRAIN ====

  async function processAndUploadDocuments(filesContentMap) {
    console.log("📤 Processing and uploading documents to vector database...");

    let uploadCount = 0;
    let skippedCount = 0;

    for (const [filename, content] of Object.entries(filesContentMap)) {
      if (!content || content.trim().length === 0) {
        console.log(`⚠️ File "${filename}" has no content. Skipping.`);
        continue;
      }

      try {
        console.log(`📤 Processing new file: ${filename}`);

        // Create chunks
        const chunks = createSimpleChunks(content, filename);

        // Generate embeddings and upload
        for (const chunk of chunks) {
          const embedding = await generateEmbedding(chunk.content);
          if (!embedding) continue;

          const vector = {
            id: chunk.id,
            values: embedding,
            metadata: {
              filename: chunk.filename,
              chunkIndex: chunk.chunkIndex,
              content: chunk.content.substring(0, 1000),
              wordCount: chunk.content.split(/\s+/).length,
            },
          };

          // Upload to Pinecone
          await fetch(`${RAG_CONFIG.SERVER_URL}/upsert`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vectors: [vector] }),
          });

          console.log(`✅ Uploaded chunk: ${chunk.id}`);

          // Rate limiting
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        // Mark the file as uploaded after successful processing
        uploadCount++;
      } catch (error) {
        console.error(`❌ Error processing ${filename}:`, error);
      }
    }

    console.log(
      `✅ Upload summary: ${uploadCount} new files uploaded, ${skippedCount} files skipped (already uploaded)`
    );
  }

  function createSimpleChunks(content, filename) {
    const chunkSize = 1000;
    const chunks = [];

    const paragraphs = content
      .split(/\n\s*\n/)
      .filter((p) => p.trim().length > 0);
    let currentChunk = "";
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length <= chunkSize) {
        currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
      } else {
        if (currentChunk) {
          chunks.push({
            id: `${filename}_chunk_${chunkIndex}`,
            content: currentChunk,
            filename: filename,
            chunkIndex: chunkIndex,
          });
          chunkIndex++;
        }
        currentChunk = paragraph;
      }
    }

    if (currentChunk) {
      chunks.push({
        id: `${filename}_chunk_${chunkIndex}`,
        content: currentChunk,
        filename: filename,
        chunkIndex: chunkIndex,
      });
    }

    return chunks;
  }

  function getActiveNamespaces() {
    const list = [];

    // 1. Meeting-specific transcript namespace (highest priority)
    if (selectedMeeting?.meetingId) {
      list.push(`meeting:${selectedMeeting.meetingId}`);
    }

    // 2. Web scraped data namespace for this meeting
    if (selectedMeeting?.meetingId) {
      list.push(`web:meeting-${selectedMeeting.meetingId}`);
    }

    // 3. Default document namespace
    list.push("siat");

    // 4. Generic web namespace (for scraped pages not tied to specific meetings)
    list.push("web");

    console.log(`Active namespaces: ${list.join(", ")}`);
    return list;
  }

  // =============================
  // Additional helper functions for enhanced search
  //
  // Levenshtein distance computes the minimum number of single-character edits
  // (insertions, deletions or substitutions) required to change one word into another.
  // This implementation is adapted for small strings and returns the distance as a
  // non‑negative integer. A zero distance means the strings are identical. For
  // performance reasons, we do not implement the full dynamic programming table for very
  // long strings. This helper will be used to compute fuzzy similarity between
  // queries and content, enabling typo‑tolerant search and approximate matching.
  function levenshteinDistance(a = "", b = "") {
    const m = a.length;
    const n = b.length;
    // If one of the strings is empty, distance is the length of the other
    if (m === 0) return n;
    if (n === 0) return m;
    // Initialize DP table
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1, // deletion
          dp[i][j - 1] + 1, // insertion
          dp[i - 1][j - 1] + cost // substitution
        );
      }
    }
    return dp[m][n];
  }

  // Fuzzy similarity returns a number between 0 and 1 that quantifies how similar
  // two strings are. It uses the Levenshtein distance normalized by the length of
  // the longer string. A result closer to 1 indicates higher similarity.
  function fuzzySimilarity(a = "", b = "") {
    const lenA = a.length;
    const lenB = b.length;
    if (lenA === 0 && lenB === 0) return 1;
    const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
    const maxLen = Math.max(lenA, lenB);
    return maxLen === 0 ? 1 : 1 - distance / maxLen;
  }

  // Compute a recency weight for a given timestamp. Newer timestamps receive a
  // higher weight, and the weight decays exponentially over time (measured in days).
  // If the timestamp is invalid or missing, the weight defaults to 1 (neutral).
  function computeRecencyWeight(timestamp) {
    if (!timestamp) return 1;
    const now = Date.now();
    const timeValue = new Date(timestamp).getTime();
    if (isNaN(timeValue)) return 1;
    const ageDays = Math.max(0, (now - timeValue) / (1000 * 60 * 60 * 24));
    // Exponential decay: weight decreases as age increases. A decay constant of 30
    // yields ~37% reduction every 30 days.
    const decay = Math.exp(-ageDays / 30);
    return 1 + decay;
  }

  // A simple static synonyms map to expand query terms. These mappings allow the
  // search functions to capture related concepts without requiring external APIs.
  // Feel free to extend this dictionary with domain‑specific terms.
  const SYNONYMS_MAP = {
    meeting: ["session", "gathering", "conference", "call"],
    project: ["assignment", "task", "initiative", "plan"],
    document: ["file", "paper", "note", "report"],
    deadline: ["due", "cutoff", "timeframe"],
    discussion: ["conversation", "dialogue", "talk"],
  };

  // Expand an array of query words by adding synonyms defined in SYNONYMS_MAP. The
  // returned array is deduplicated so that each term appears only once. This helps
  // the keyword search portion of the algorithm match more relevant content.

  function cleanTextForSpeech(text) {
    return (
      text
        // Remove URLs and replace with descriptive text
        .replace(/https:\/\/drive\.google\.com\/\S+/g, "your Drive folder")
        .replace(/https:\/\/meet\.google\.com\/\S+/g, "your meeting link")
        .replace(/https?:\/\/\S+/g, "a link")

        // Remove HTML tags
        .replace(/<[^>]*>/g, "")

        // Remove markdown formatting
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")

        // Remove special characters that don't speak well
        .replace(/[📁📄🔍✅❌⚠️🎯📝🔄💡]/g, "")

        // Replace common symbols
        .replace(/&amp;/g, "and")
        .replace(/&lt;/g, "less than")
        .replace(/&gt;/g, "greater greater than")

        // Limit length for better speech
        .substring(0, 800)

        // Clean up extra spaces
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  // Rest of your existing functions...

  // Enhanced analyzeQuestionIntent function
  function analyzeQuestionIntent(query) {
    const queryLower = query.toLowerCase();

    // Check for explicit file extensions
    if (/\.(pptx|docx?|pdf|txt|csv|md)$/i.test(queryLower))
      return "file_content";

    const patterns = {
      drive_files: [
        // More comprehensive Drive file patterns
        /\b(show|give|list|display|find|what).*\b(files?|documents?|drive|folder)\b/i,
        /\bfiles? in\b.*\b(drive|folder)\b/i,
        /\bwhat.*inside.*drive\b/i,
        /\blist.*documents?\b/i,
        /\bshow.*folder\b/i,
        /\bdrive folder\b/i,
        /\ball.*files?\b/i,
        /\bavailable.*files?\b/i,
        /\bfiles?.*uploaded\b/i,
        /\buploaded.*files?\b/i,
        /^what files/i,
        /^which files/i,
        /^any files/i,
        /^files in/i,
        /^documents in/i,
        /\bfolder.*contents?\b/i,
        /\bcontents?.*of.*folder\b/i,
        /\bdrive.*contents?\b/i,
      ],

      file_content: [
        /\b(?:_?[A-Za-z0-9\s-]+\.docx?)\b/i,
        /\b(?:_?[A-Za-z0-9\s-]+\.txt|\.csv|\.md|\.pdf|\.pptx)\b/i,
        /\bread.*file/i,
        /\bopen.*file/i,
        /\bshow.*file/i,
        /\bextract.*from.*file/i,
        /\bwhat.*(?:inside|in|from).*file/i,
        /\bfile.*contains?\b/i,
        /\bcontents? of\b.*file/i,
        /\bdata.*in.*file/i,
        /\binfo.*from.*file/i,
      ],

      meeting_transcript: [
        /\b(what.*did|who.*said|when.*did|how.*did|why.*did)\b/i,
        /\b(discuss|discussed|talk|talked|mention|mentioned|said|spoke)\b/i,
        /\b(meeting|conversation|call|session)\b/i,
        /\b(decide|decided|agree|agreed|conclude|concluded)\b/i,
        /\b(action.*item|next.*step|follow.*up|task)\b/i,
        /\bhappened.*in.*meeting\b/i,
        /\bwhat.*was.*discussed\b/i,
        /\bwho.*was.*present\b/i,
        /\bmeeting.*about\b/i,
        /\btranscript/i,
      ],

      search_files: [
        /\bsearch.*in.*files?\b/i,
        /\bfind.*in.*documents?\b/i,
        /\blook.*for.*in.*drive\b/i,
        /\bsearch.*drive.*for\b/i,
      ],

      file_search: [
        /\bsearch\b.*\bfor\b/i,
        /\bfind\b.*\bfile/i,
        /\blook.*for\b/i,
      ],
    };

    for (const [intent, regexArray] of Object.entries(patterns)) {
      if (regexArray.some((regex) => regex.test(queryLower))) {
        console.log(`🎯 Intent detected: ${intent} for query: "${queryLower}"`);
        return intent;
      }
    }

    console.log(`🎯 Intent detected: general for query: "${queryLower}"`);
    return "general";
  }

  // ENHANCED AI RESPONSE FUNCTION WITH INTELLIGENT SOURCE PRIORITIZATION
  async function getRAGResponseWithContext(
    input,
    selectedMeeting,
    userUid,
    filesContentMap,
    getAIResponse
  ) {
    console.log(`🤖 Processing RAG query with context: ${input}`);
    // Always initialize to empty arrays so spread/concat never crash
    let documentResults = [];
    let transcriptResults = [];
    let webScrapResults = [];
    // Cancel any previous question's in-flight searches, then create ONE controller for this question
    abortActiveSearch();
    activeSearchAborter = new AbortController();
    const signal = activeSearchAborter.signal;

    let context = "";
    let searchResults = [];
    let sourceInfo = "";

    // 1. Analyze user intent and explicit source mentions
    const sourceIntent = analyzeSourceIntent(input);
    console.log(`🎯 Detected source intent: ${sourceIntent.type}`);

    // Precompute the embedding ONCE per call (fast path); if it times out, we will fall back
    let queryEmbedding = null;
    try {
      queryEmbedding = await withTimeout(getQueryEmbeddingOnce(input), 6000);
    } catch (_) {
      // fallback will use performRAGSearch(query, ns, { signal })
    }

    if (sourceIntent.type === "transcript_only") {
      // 2A. User explicitly mentioned transcript/meeting - ONLY search transcripts
      console.log("📝 User explicitly requested transcript information");

      try {
        transcriptResults =
          queryEmbedding && selectedMeeting?.meetingId
            ? await performRAGSearchWithEmbedding(
              queryEmbedding,
              selectedMeeting.meetingId,
              { signal }
            )
            : await performRAGSearch(input, selectedMeeting?.meetingId, {
              signal,
            }); // fallback

        if (transcriptResults.length > 0) {
          context = "MEETING TRANSCRIPT CONTEXT:\n\n";
          transcriptResults.forEach((result, index) => {
            context += `Transcript Segment ${index + 1}:\n`;
            context += `Relevance: ${result.similarity.toFixed(3)}\n`;
            context += `Content: "${result.content}"\n\n`;
          });
          searchResults = transcriptResults;
          sourceInfo = "Sources: Meeting Transcript";
        } else {
          // Fallback to full transcript
          const transcript = await loadTranscript(
            userUid,
            selectedMeeting.meetingId
          );
          if (transcript && transcript.length > 0) {
            context = `MEETING TRANSCRIPT:\n${transcript.substring(
              0,
              4000
            )}...\n\n`;
            sourceInfo = "Sources: Meeting Transcript (Full)";
          }
        }
      } catch (error) {
        // If this batch was aborted because a new query started, quietly exit
        if (error?.name === "AbortError") {
          console.log("↪️ Transcript-only search aborted (new query started).");
          return;
        }
        console.warn("Could not load transcript:", error);
        context = "⚠️ Could not access meeting transcript.\n\n";
      }
    } else if (sourceIntent.type === "files_only") {
      // 2B. User explicitly mentioned files/drive - ONLY search documents
      console.log("📁 User explicitly requested file information");

      try {
        documentResults = queryEmbedding
          ? await performRAGSearchWithEmbedding(
            queryEmbedding,
            "meeting-assistant",
            { signal }
          ) // default/doc namespace
          : await performRAGSearch(input, "meeting-assistant", { signal }); // fallback
        if (documentResults.length > 0) {
          context = "GOOGLE DRIVE FILES CONTEXT:\n\n";
          documentResults.forEach((result, index) => {
            context += `Document ${index + 1}: ${result.filename}\n`;
            context += `Relevance: ${result.similarity.toFixed(3)}\n`;
            context += `Content: "${result.content}"\n\n`;
          });
          searchResults = documentResults;
          sourceInfo = "Sources: Google Drive Files";
        } else {
          context = "⚠️ No relevant information found in Drive files.\n\n";
          sourceInfo = "Sources: Google Drive Files (No matches)";
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          console.log("↪️ Files-only search aborted (new query started).");
          return;
        }
        console.warn("Error in files-only search:", error);
        context = "⚠️ Error accessing files.\n\n";
        sourceInfo = "Sources: Error";
      }
    } else {
      // 2C. No explicit source mentioned - search BOTH (and web-scraped namespace), in PARALLEL
      console.log(
        "🔍 No explicit source mentioned, searching both transcript and files"
      );

      try {
        // Build the search fan-out with one embedding; pass the SAME signal to all
        const searches = [];

        // default/doc namespace
        if (queryEmbedding) {
          searches.push(
            performRAGSearchWithEmbedding(queryEmbedding, "meeting-assistant", {
              signal,
            })
          );
        } else {
          searches.push(
            performRAGSearch(input, "meeting-assistant", { signal })
          );
        }

        // transcript namespace (raw meetingId)
        if (selectedMeeting?.meetingId) {
          if (queryEmbedding) {
            searches.push(
              performRAGSearchWithEmbedding(
                queryEmbedding,
                selectedMeeting.meetingId,
                { signal }
              )
            );
          } else {
            searches.push(
              performRAGSearch(input, selectedMeeting.meetingId, { signal })
            );
          }
        } else {
          searches.push(Promise.resolve([]));
        }

        // web-scraped namespace (meeting:<id>)
        if (selectedMeeting?.meetingId) {
          const webNs = `meeting:${selectedMeeting.meetingId}`;
          if (queryEmbedding) {
            searches.push(
              performRAGSearchWithEmbedding(queryEmbedding, webNs, { signal })
            );
          } else {
            searches.push(performRAGSearch(input, webNs, { signal }));
          }
        } else {
          searches.push(Promise.resolve([]));
        }

        // Run in parallel
        const [docRes, trnRes, webRes] = await Promise.all(searches);
        documentResults = docRes || [];
        transcriptResults = trnRes || [];
        webScrapResults = webRes || [];

        // Fallback to full transcript if transcript search empty
        // if (transcriptResults.length === 0 && selectedMeeting?.meetingId) {
        //   const transcript = await loadTranscript(userUid, selectedMeeting.meetingId);
        //   if (transcript && transcript.length > 0) {
        //     transcriptResults = [{
        //       content: transcript.substring(0, 2000),
        //       similarity: 0.5,
        //       filename: "Meeting Transcript",
        //       source: "transcript"
        //     }];
        //   }
        // }

        // Build combined context
        if (
          transcriptResults.length > 0 ||
          documentResults.length > 0 ||
          webScrapResults.length > 0
        ) {
          context = "";
          let sources = [];

          if (transcriptResults.length > 0) {
            context += "MEETING TRANSCRIPT CONTEXT:\n\n";
            transcriptResults.forEach((result, index) => {
              context += `Transcript Segment ${index + 1}:\n`;
              context += `Content: "${result.content}"\n\n`;
            });
            sources.push("Meeting Transcript");
          }

          if (documentResults.length > 0) {
            context += "GOOGLE DRIVE FILES CONTEXT:\n\n";
            documentResults.forEach((result, index) => {
              context += `Document ${index + 1}: ${result.filename}\n`;
              context += `Content: "${result.content}"\n\n`;
            });
            sources.push("Google Drive Files");
          }

          if (webScrapResults.length > 0) {
            context += "Web Scraped CONTEXT:\n\n";
            webScrapResults.forEach((result, index) => {
              context += `Content: "${result.content}"\n\n`;
            });
            sources.push("Web Scraped Data");
          }

          searchResults = [
            ...transcriptResults,
            ...documentResults,
            ...webScrapResults,
          ];
          sourceInfo = `Sources: ${sources.join(" + ")}`;
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          console.log("↪️ Combined search aborted (new query started).");
          return;
        }
        console.warn("Error in combined search:", error);
        context = "⚠️ Error accessing meeting data.\n\n";
        sourceInfo = "Sources: Error";
      }
    }

    // 3. Build conversation context
    let conversationContext = "";
    if (conversationHistory.length > 0) {
      conversationContext = "RECENT CONVERSATION:\n";
      const recentHistory = conversationHistory.slice(-6);
      recentHistory.forEach((msg) => {
        const role = msg.role === "user" ? "User" : "Assistant";
        conversationContext += `${role}: ${msg.content}\n`;
      });
      conversationContext += "\n";
    }

    // Normalize shapes and combine results
    const toHits = (r) =>
      Array.isArray(r) ? r : r?.matches || r?.results || [];
    const allMatches = [
      ...toHits(documentResults),
      ...toHits(transcriptResults),
      ...toHits(webScrapResults),
    ];

    console.log("🧩 Combined hits:", allMatches.length);
    // 5. Use grounded answer pipeline (anti-copy)
    try {
      //const allMatches = [...(transcriptResults || []), ...(documentResults || []), ...(webScrapResults || [])];

      if (allMatches.length === 0) {
        // No evidence - use conversation context
        let contextPrompt = conversationContext
          ? `You are an intelligent meeting assistant.\n\n${conversationContext}\n\nNo specific documents found. Answer based on general knowledge and conversation context.`
          : "You are an intelligent meeting assistant. Answer based on general knowledge.";

        const messages = [
          { role: "system", content: contextPrompt },
          { role: "user", content: input },
        ];
        const aiReply = await getAIResponse(messages);
        return {
          response: aiReply,
          searchResults: [],
          hasResults: false,
          sourceInfo: "General Knowledge",
        };
      }

      // Use RAG brain to create paraphrased, cited answer
      const { answer, hasEvidence, sources } = await getGroundedAnswer(
        input,
        allMatches,
        getAIResponse
      );

      // Build source attribution
      let sourcesList = new Set();
      if (transcriptResults?.length > 0) sourcesList.add("Meeting Transcript");
      if (documentResults?.length > 0) sourcesList.add("Google Drive Files");
      if (webScrapResults?.length > 0) sourcesList.add("Web Scraped Data");

      const finalSourceInfo =
        sourcesList.size > 0
          ? `Sources: ${Array.from(sourcesList).join(" + ")}`
          : "Sources: Documents";

      return {
        response: answer,
        searchResults: allMatches,
        hasResults: hasEvidence,
        sourceInfo: finalSourceInfo,
      };
    } catch (error) {
      console.error("RAG brain error:", error);
      const messages = [
        {
          role: "system",
          content: "You are a helpful assistant. Answer concisely.",
        },
        { role: "user", content: input },
      ];
      const aiReply = await getAIResponse(messages);
      return {
        response: aiReply,
        searchResults: [],
        hasResults: false,
        sourceInfo: "Error - Fallback Mode",
      };
    }
  }

  // Helper function to analyze user's source intent
  function analyzeSourceIntent(query) {
    const queryLower = query.toLowerCase();

    // Patterns for explicit transcript/meeting mentions (ENHANCED)
    const transcriptPatterns = [
      /\b(transcript|meeting transcript)\b/i,
      /\b(what.*discussed.*(?:in|during).*meeting)\b/i,
      /\b(what.*(?:is|was).*discussed.*(?:in|during).*meeting)\b/i,
      /\b(meeting.*summary|meeting.*recap|summarize.*meeting)\b/i,
      /\b(what.*happened.*(?:in|during).*meeting)\b/i,
      /\b(meeting.*about|meeting.*discussion)\b/i,
      /\b(from.*meeting|in.*meeting|during.*meeting)\b/i,
      /\b(conversation|call|session)\b/i,
      /\b(who.*said.*(?:in|during).*meeting)\b/i,
      /\b(what.*(?:talked|mentioned|said).*(?:in|during).*meeting)\b/i,
      /\b(action.*items?.*(?:from|in).*meeting)\b/i,
      /\b(decisions?.*(?:made|from).*meeting)\b/i,
      // Add more specific patterns
      /^what.*discussed.*meeting$/i, // "what is discussed in the meeting"
      /^what.*meeting.*about$/i, // "what was the meeting about"
      /^meeting.*discussion$/i, // "meeting discussion"
      /^give.*meeting.*summary$/i, // "give me meeting summary"
    ];

    // Patterns for explicit file/drive mentions
    const filePatterns = [
      /\b(file|files|document|documents|google drive)\b/i,
      /\b(\.pdf|\.docx|\.txt|\.csv|\.pptx|\.doc)\b/i,
      /\b(from.*file|in.*file|file.*contains|file.*says)\b/i,
      /\b(drive.*folder|folder|uploaded|drive)\b/i,
      /\b([a-zA-Z0-9_-]+\.(pdf|docx|txt|csv|pptx|doc))\b/i, // specific file names
      /\b(what.*(?:in|inside).*file)\b/i,
      /\b(show.*file|open.*file|read.*file)\b/i,
    ];

    // Check for explicit mentions
    const mentionsTranscript = transcriptPatterns.some((pattern) =>
      pattern.test(queryLower)
    );
    const mentionsFiles = filePatterns.some((pattern) =>
      pattern.test(queryLower)
    );

    console.log(`🔍 Query analysis: "${queryLower}"`);
    console.log(`📝 Mentions transcript: ${mentionsTranscript}`);
    console.log(`📁 Mentions files: ${mentionsFiles}`);

    if (mentionsTranscript && !mentionsFiles) {
      console.log(`✅ Classified as: transcript_only`);
      return { type: "transcript_only", confidence: "high" };
    } else if (mentionsFiles && !mentionsTranscript) {
      console.log(`✅ Classified as: files_only`);
      return { type: "files_only", confidence: "high" };
    } else if (mentionsTranscript && mentionsFiles) {
      console.log(`✅ Classified as: both_mentioned`);
      return { type: "both_mentioned", confidence: "medium" };
    } else {
      console.log(`✅ Classified as: search_both (no explicit mention)`);
      return { type: "search_both", confidence: "low" };
    }
  }

  // function highlightSearchTerms(text, searchTerms) {
  //   if (!searchTerms || searchTerms.length === 0) return text;
  //   let highlightedText = text;

  //   searchTerms.forEach(term => {
  //     const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  //     const regex = new RegExp(`\\b(${escapedTerm})\\b`, 'gi');
  //     highlightedText = highlightedText.replace(regex, '<mark>$1</mark>');
  //   });

  //   return highlightedText;
  // }

  // Helper functions for Drive API
  function extractFolderId(driveUrl) {
    if (!driveUrl) return null;
    const match = driveUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  function linkify(text) {
    if (!text) return "";
    const urlPattern = /https?:\/\/[^\s"<>]+/g;
    return text.replace(urlPattern, (url) => {
      const safeUrl = url.replace(/"/g, "");
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
  }

  // Save chat message to Firestore
  async function saveChatMessage(uid, meetingId, role, content) {
    if (!uid || !meetingId) return;
    try {
      await loadDependencies();
      await addDoc(collection(db, "users", uid, "meetings", meetingId, "chats"), {
        role,
        content,
        timestamp: serverTimestamp()
      });
    } catch (e) {
      console.error("Save chat failed:", e);
    }
  }

  function getAuthToken() {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError || !token) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(token);
        }
      });
    });
  }

  // ENHANCED DRIVE FUNCTIONS
  async function verifyFolderAccess(folderId, token) {
    try {
      const folderRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType,trashed&supportsAllDrives=true`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!folderRes.ok) {
        throw new Error(`Cannot access folder: ${folderRes.status}`);
      }

      const folderData = await folderRes.json();

      if (folderData.trashed) {
        throw new Error("Folder is in trash");
      }

      if (folderData.mimeType !== "application/vnd.google-apps.folder") {
        throw new Error("ID does not point to a folder");
      }

      console.log(`✅ Folder verified: ${folderData.name}`);
      return folderData;
    } catch (error) {
      console.error("Folder verification failed:", error);
      throw error;
    }
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return "0 Bytes";
    if (isNaN(bytes)) return "Unknown size";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  async function listFilesInFolder(folderId, token) {
    const files = [];

    async function recurse(folderId, path = "") {
      try {
        const query = `'${folderId}' in parents and trashed=false`;
        const fields =
          "files(id,name,mimeType,size,modifiedTime,createdTime,md5Checksum,webViewLink,parents,trashed)";

        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
            query
          )}&fields=${fields}&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (!res.ok) {
          console.error(`Drive API error: ${res.status} - ${res.statusText}`);
          const errorText = await res.text();
          console.error("Error details:", errorText);
          throw new Error(`Drive API error: ${res.status}`);
        }

        const data = await res.json();
        console.log(
          `📁 Found ${data.files?.length || 0} files in folder ${folderId}`
        );

        if (!data.files || !Array.isArray(data.files)) {
          console.warn("No files array in response:", data);
          return;
        }

        for (const file of data.files) {
          if (file.trashed === true) {
            console.log(`Skipping trashed file: ${file.name}`);
            continue;
          }

          const fullPath = path ? `${path}/${file.name}` : file.name;

          if (file.mimeType === "application/vnd.google-apps.folder") {
            console.log(`📂 Entering subfolder: ${fullPath}`);
            await recurse(file.id, fullPath);
          } else {
            if (file.id && file.name) {
              files.push({
                ...file,
                path: fullPath,
                displaySize: file.size
                  ? formatFileSize(parseInt(file.size))
                  : "Unknown size",
              });
              console.log(`📄 Added file: ${file.name} (${file.displaySize})`);
            }
          }
        }
      } catch (error) {
        console.error(`Error accessing folder ${folderId}:`, error);
      }
    }

    await recurse(folderId);
    console.log(`✅ Total files collected: ${files.length}`);
    return files;
  }

  async function getFreshFileList(folderId, token, forceRefresh = false) {
    const cacheKey = `drive_files_${folderId}`;
    const cacheTimeKey = `drive_files_time_${folderId}`;
    const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

    try {
      if (!forceRefresh) {
        const cachedData = await chrome.storage.local.get([
          cacheKey,
          cacheTimeKey,
        ]);
        if (cachedData[cacheKey] && cachedData[cacheTimeKey]) {
          const cacheAge = Date.now() - cachedData[cacheTimeKey];
          if (cacheAge < CACHE_DURATION) {
            console.log("📦 Using cached file list");
            return cachedData[cacheKey];
          }
        }
      }

      console.log("🔄 Fetching fresh file list from Drive...");

      await verifyFolderAccess(folderId, token);
      const files = await listFilesInFolder(folderId, token);

      await chrome.storage.local.set({
        [cacheKey]: files,
        [cacheTimeKey]: Date.now(),
      });

      console.log(`✅ Cached ${files.length} files`);
      return files;
    } catch (error) {
      console.error("Error getting fresh file list:", error);
      throw error;
    }
  }

  // Continue with the rest of the Drive functions and chat interface...
  // [Rest of your existing code for file downloading, chat interface, etc.]

  // Enhanced function to download different file types
  async function downloadGoogleDocAsText(fileId, token) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok)
      throw new Error("Failed to download Google Doc: " + res.status);
    return await res.text();
  }

  async function downloadPlainTextFile(fileId, token) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok) throw new Error("Failed to download text file: " + res.status);
    return await res.text();
  }

  function loadMammothIfNeeded() {
    return new Promise((resolve, reject) => {
      if (window.mammoth) return resolve(window.mammoth);

      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("libs/mammoth.browser.min.js");
      script.onload = () => resolve(window.mammoth);
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  function loadPptxParserIfNeeded() {
    return new Promise((resolve, reject) => {
      if (window.pptxToText) return resolve(window.pptxToText);

      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("libs/pptx-parser.js");
      script.onload = () => resolve(window.pptxToText);
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // Load pdf.js and pdf.worker.js if not already loaded
  function loadPdfJSIfNeeded() {
    return new Promise((resolve, reject) => {
      if (window.pdfjsLib) return resolve(window.pdfjsLib);

      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("libs/pdf.js");

      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          chrome.runtime.getURL("libs/pdf.worker.js");
        resolve(window.pdfjsLib);
      };

      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // Function to download and process different file types
  async function downloadFileContent(file, token) {
    try {
      let content = "";

      switch (file.mimeType) {
        case "application/vnd.google-apps.document":
          content = await downloadGoogleDocAsText(file.id, token);
          break;

        case "text/plain":
        case "text/csv":
        case "text/markdown":
          content = await downloadPlainTextFile(file.id, token);
          break;

        case "application/vnd.google-apps.spreadsheet": {
          const csvRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          if (csvRes.ok) {
            content = await csvRes.text();
          }
          break;
        }

        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
          const blobRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );

          if (!blobRes.ok)
            throw new Error(`Failed to download DOCX file: ${blobRes.status}`);
          const blob = await blobRes.blob();
          const arrayBuffer = await blob.arrayBuffer();

          await loadMammothIfNeeded();
          const { convertToHtml } = window.mammoth;

          const result = await convertToHtml({ arrayBuffer });
          content = result.value.replace(/<[^>]+>/g, ""); // Strip HTML tags
          break;
        }

        case "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
          const blobRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );

          if (!blobRes.ok)
            throw new Error(`Failed to download PPTX file: ${blobRes.status}`);
          const blob = await blobRes.blob();
          const arrayBuffer = await blob.arrayBuffer();

          await loadPptxParserIfNeeded();
          const text = await window.pptxToText(arrayBuffer);
          content = text;
          break;
        }

        case "application/pdf": {
          const res = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );

          if (!res.ok)
            throw new Error(`Failed to download PDF file: ${res.status}`);
          const blob = await res.blob();
          const arrayBuffer = await blob.arrayBuffer();

          await loadPdfJSIfNeeded();

          const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer })
            .promise;

          let text = "";
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const pageContent = await page.getTextContent();
            const pageText = pageContent.items
              .map((item) => item.str)
              .join(" ");
            text += pageText + "\n\n";
          }

          content = text;
          break;
        }

        default:
          console.log(
            `Unsupported file type: ${file.mimeType} for file: ${file.name}`
          );
          return null;
      }

      return content;
    } catch (error) {
      console.error(`Error downloading file ${file.name}:`, error);
      return null;
    }
  }

  // Enhanced search function with better filtering
  async function searchFilesRecursively(folderId, queryText, token) {
    const matches = [];
    // Normalize query text once for reuse. If queryText is empty or undefined,
    // queryLower will be an empty string. We use this for fuzzy matching below.
    const queryLower = (queryText || "").trim().toLowerCase();

    async function searchFolder(folderId, path = "") {
      try {
        // Build proper query to exclude trashed files
        let query = `'${folderId}' in parents and trashed=false`;
        if (queryText && queryText.trim()) {
          // Add name search to the query
          query += ` and name contains '${queryText.replace(/'/g, "\\'")}'`;
        }

        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
          query
        )}&fields=files(id,name,mimeType,webViewLink,size,modifiedTime,trashed)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000`;

        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });

        if (res.status === 403) {
          const err = new Error("Access denied to Drive folder");
          err.status = 403;
          throw err;
        }

        if (!res.ok) {
          throw new Error(`Drive API error: ${res.status}`);
        }

        const data = await res.json();

        if (!data.files || !Array.isArray(data.files)) {
          console.error("Drive API error or no files:", data);
          return;
        }

        console.log(`🔍 Search found ${data.files.length} matches in folder`);

        for (const file of data.files) {
          // Skip trashed files (double check)
          if (file.trashed === true) continue;
          const fullPath = path ? `${path}/${file.name}` : file.name;

          // Decide whether to include this file based on fuzzy match with its name.
          let includeFile = true;
          let fuzzySim = 0;
          if (queryLower) {
            const nameLower = file.name.toLowerCase();
            fuzzySim = fuzzySimilarity(queryLower, nameLower);
            // Only include the file if it either contains the query substring or
            // has a sufficiently high fuzzy similarity. This allows approximate
            // matches and typo tolerance while filtering out unrelated results.
            if (!nameLower.includes(queryLower) && fuzzySim < 0.6) {
              includeFile = false;
            }
          }

          if (includeFile) {
            // Compute recency weight based on the file's modifiedTime to favor recent documents
            const recencyWeight = computeRecencyWeight(file.modifiedTime);
            matches.push({
              ...file,
              path: fullPath,
              displaySize: file.size
                ? formatFileSize(parseInt(file.size))
                : "Unknown size",
              similarity: fuzzySim,
              recencyWeight: recencyWeight,
            });
          }

          // If it's a folder, search recursively
          if (file.mimeType === "application/vnd.google-apps.folder") {
            await searchFolder(file.id, fullPath);
          }
        }
      } catch (error) {
        console.error(`Error searching folder ${folderId}:`, error);
        if (error.status === 403) {
          throw error;
        }
      }
    }

    await searchFolder(folderId);
    console.log(`🔍 Total search results: ${matches.length}`);
    // Sort results by a combination of fuzzy similarity and recency weight if available.
    // Files that have both a high fuzzy similarity and recent modification date will
    // appear earlier in the list. If these properties are not present, they
    // default to zero/one and will not affect ordering significantly.
    matches.sort((a, b) => {
      const scoreA = (a.similarity || 0) * (a.recencyWeight || 1);
      const scoreB = (b.similarity || 0) * (b.recencyWeight || 1);
      return scoreB - scoreA;
    });
    return matches;
  }

  // Main chat interface initialization
  loadDependencies()
    .then(() => {
      // Get DOM elements
      chatMessages = document.getElementById("chatMessages");
      chatInput = document.getElementById("chatInput");
      micBtn = document.getElementById("micBtn");
      voiceReplyToggle = document.getElementById("voiceReplyToggle");
      sendBtn = document.getElementById("sendBtn");

      if (!chatMessages) {
        console.error(
          "Error: Element with id 'chatMessages' not found in the DOM."
        );
        return;
      }
      if (!chatInput) {
        console.error(
          "Error: Element with id 'chatInput' not found in the DOM."
        );
        return;
      }
      if (!micBtn) {
        console.warn(
          "Warning: Element with id 'micBtn' not found; microphone functionality will be disabled."
        );
      }
      if (!voiceReplyToggle) {
        console.warn(
          "Warning: Element with id 'voiceReplyToggle' not found; voice reply toggle will be disabled."
        );
      }
      if (!sendBtn) {
        console.warn(
          "Warning: Element with id 'sendBtn' not found; send button functionality will be disabled."
        );
      }

      synth = window.speechSynthesis;

      function initSpeechRecognition() {
        const SpeechRecognition =
          window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
          console.warn("Speech Recognition not supported in this browser.");
          if (micBtn) micBtn.disabled = true;
          return;
        }

        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = "en-US";

        recognition.onstart = () => {
          isMicActive = true;
          if (micBtn) {
            micBtn.textContent = "●";
            micBtn.style.color = "red";
            micBtn.title = "Listening... Click to stop";
          }
        };

        recognition.onend = () => {
          isMicActive = false;
          if (micBtn) {
            micBtn.textContent = "🎤";
            micBtn.style.color = "";
            micBtn.title = "Speak your question";
          }
        };

        recognition.onerror = (e) => {
          console.error("Speech error:", e.error);
          isMicActive = false;
          if (micBtn) {
            micBtn.textContent = "🎤";
            micBtn.style.color = "";
            micBtn.title = "Speak your question";
          }
        };

        recognition.onresult = (event) => {
          const transcript = event.results[0][0].transcript.trim();
          if (chatInput) {
            chatInput.value = transcript;
            chatInput.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter" })
            );
          }
        };
      }

      // Load meeting data and chat history (backup check)
      chrome.storage.local.get(
        ["selectedMeetingForChat", "uid"],
        async (result) => {
          if (result.selectedMeetingForChat && result.uid) {
            // Already set by FAST PATH, but update just in case
            selectedMeeting = result.selectedMeetingForChat;
            userUid = result.uid;

            // Pre-load Drive files for better performance
            await preloadDriveFiles();
          } else {
            console.warn(
              "No meeting selected. Please open chat from the dashboard after selecting a meeting."
            );
            if (chatMessages) {
              const warningBubble = document.createElement("div");
              warningBubble.className = "chat-bubble ai-bubble";
              warningBubble.innerHTML =
                "⚠️ No meeting selected. Please open chat from the dashboard after selecting a meeting.";
              chatMessages.appendChild(warningBubble);
            }
          }
        }
      );

      // Function to preload Drive files
      async function preloadDriveFiles() {
        if (!selectedMeeting?.driveFolderLink) return;

        const folderId = extractFolderId(selectedMeeting.driveFolderLink);
        if (!folderId) return;

        try {
          // Ensure dependencies are loaded (for indexUrlsFromFiles)
          await loadDependencies();

          console.log("🔄 Loading Drive files...");
          await loadUploadedFilesList();

          const token = await getAuthToken();
          const files = await getFreshFileList(folderId, token);

          const supportedFiles = files.filter(
            (f) =>
              f.mimeType === "text/plain" ||
              f.mimeType === "application/vnd.google-apps.document" ||
              f.mimeType ===
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
              f.mimeType === "application/pdf" ||
              f.mimeType === "text/csv" ||
              f.mimeType === "application/vnd.google-apps.spreadsheet" ||
              f.mimeType ===
              "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          );

          console.log(
            `📂 Found ${supportedFiles.length} supported files in Drive`
          );
          console.log(
            `📦 Cache contains ${Object.keys(uploadedFiles).length
            } file revisions (id → revSig).`
          );

          const filesToProcess = {};
          for (const file of supportedFiles.slice(0, 10)) {
            // skip very large files (> ~5MB) – keep your existing size gate if you want
            if (file.size && parseInt(file.size) >= 5000000) continue;

            // Build a robust revision signature:
            // Prefer md5Checksum (present for binaries like .pptx/.docx/.pdf),
            // else modifiedTime+size (for Google Docs often no md5),
            // else createdTime as a last resort.
            const revSig =
              file.md5Checksum ||
              (file.modifiedTime
                ? `${file.modifiedTime}|${file.size || ""}`
                : null) ||
              file.createdTime ||
              "unknown";

            // Ensure our cache map exists (migration safety)
            if (
              !uploadedFiles ||
              typeof uploadedFiles !== "object" ||
              Array.isArray(uploadedFiles)
            ) {
              uploadedFiles = {};
            }

            const already =
              uploadedFiles[file.id] && uploadedFiles[file.id] === revSig;
            if (already) {
              console.log(`⏭️ Skipping up-to-date file: ${file.name}`);
              continue;
            }

            try {
              console.log(`📖 Loading new/updated file: ${file.name}`);
              const content = await downloadFileContent(file, token);
              if (content && content.trim().length > 0) {
                filesToProcess[file.name.toLowerCase()] = content;
                filesContentMap[file.name.toLowerCase()] = content; // keep for local search
                // Mark as processed for THIS revision so we don't reprocess on reload
                uploadedFiles[file.id] = revSig;
              }
            } catch (error) {
              console.warn(`Failed to load ${file.name}:`, error);
            }
          }

          if (Object.keys(filesToProcess).length > 0) {
            console.log(
              `📤 Uploading ${Object.keys(filesToProcess).length
              } new files to vector database...`
            );
            await processAndUploadDocuments(filesToProcess);
            await saveUploadedFilesList();
          } else {
            console.log(
              `✅ All files already processed. RAG system ready with ${Object.keys(uploadedFiles).length
              } documents`
            );
          }

          // 🔗 NEW: scan file contents for external links and index them into Pinecone
          try {
            const nsHint = selectedMeeting?.meetingId
              ? `meeting:${selectedMeeting.meetingId}`
              : undefined;
            const res = await indexUrlsFromFiles(filesContentMap, nsHint, 1500);
            console.log("🌐 Link indexing summary:", res);
          } catch (e) {
            console.warn("External link indexing issue:", e);
          }
        } catch (error) {
          console.warn("Failed to setup RAG system:", error?.message || error);
        }
      }

      // Enhanced chat input handler with semantic search
      // Enhanced chat input handler with proper Drive file routing
      chatInput.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter" || isProcessing) return;
        isProcessing = true;

        const input = chatInput.value.trim();
        if (!input) {
          isProcessing = false;
          return;
        }

        chatInput.value = "";

        // Add user message to conversation history + UI
        conversationHistory.push({ role: "user", content: input });

        const userBubble = document.createElement("div");
        userBubble.className = "chat-bubble user-bubble";
        userBubble.textContent = input;
        chatMessages.appendChild(userBubble);
        scrollToBottom(true);

        const aiBubble = document.createElement("div");
        aiBubble.className = "chat-bubble ai-bubble";
        aiBubble.innerHTML =
          '<div class="typing-indicator">🔍 Processing your request...</div>';
        chatMessages.appendChild(aiBubble);
        scrollToBottom(true);

        try {
          // --- Fast path A: If the user pasted a URL, do URL-based Q&A ---
          if (isUrlLike(input)) {
            try {
              aiBubble.innerHTML =
                '<div class="typing-indicator">🌐 Scraping the page…</div>';
              const { title, url, text } = await scrapeUrl(input);

              aiBubble.innerHTML =
                '<div class="typing-indicator">🧠 Answering from that page…</div>';

              // If the user only pasted a URL (no other words), default to a summary-style question
              let question = `Please answer based on that page: ${input}`;
              const onlyUrl = /^https?:\/\/\S+$/i.test(input.trim());
              if (onlyUrl) {
                question = [
                  `Summarize the page in 5 concise bullet points, then list 5 key facts/numbers/dates.`,
                  `If it's about a person, include a 2‑line bio and most recent major roles/events.`,
                  `Stick strictly to the scraped content.`,
                ].join(" ");
              }

              const messages = buildMessagesForUrlQA(question, text);
              const tw = makeTypewriter(aiBubble, { wps: 10 });

              const answer = await getAIResponse(messages, {
                onToken: (t) => tw.onToken(t),
              });

              await tw.finish(answer, {
                postProcess: () => {
                  aiBubble.innerHTML += `<div style="margin-top:10px">
      <a href="${url}" target="_blank" rel="noopener noreferrer">${title || url
                    }</a>
    </div>`;
                },
              });
              // Fire-and-forget: index this page for future RAG (meeting-aware)
              const nsHint = selectedMeeting?.meetingId
                ? `meeting:${selectedMeeting.meetingId}`
                : undefined;
              scrapeAndUpsert(input, nsHint).catch(() => { });
            } catch (err) {
              console.error(err);
              aiBubble.innerHTML =
                "⚠️ Failed to scrape that page. Please check the URL and try again.";
            }

            // Save both messages
            if (userUid && selectedMeeting?.meetingId) {
              const responseText = aiBubble.textContent || aiBubble.innerText;
              saveChatMessage(
                userUid,
                selectedMeeting.meetingId,
                "user",
                input
              );
              saveChatMessage(
                userUid,
                selectedMeeting.meetingId,
                "assistant",
                responseText
              );
            }

            isProcessing = false;
            scrollToBottom(true);
            return;
          }

          // --- Fast path B: "web-search-y" queries -> SERP ---
          if (detectWebSearchyQuery(input)) {
            try {
              aiBubble.innerHTML =
                '<div class="typing-indicator">🔎 Searching the web…</div>';
              const results = await serpSearch(input);
              if (!results.length) {
                aiBubble.innerHTML = "No web results found.";
              } else {
                let brief = `Here are relevant results:\n\n`;
                const top = results.slice(0, 5);
                top.forEach((r, i) => {
                  brief += `${i + 1}. ${r.title}\n${r.snippet || ""}\n${r.link
                    }\n\n`;
                });
                aiBubble.innerHTML = linkify(brief.trim());
              }
            } catch (err) {
              console.error(err);
              aiBubble.innerHTML = "⚠️ Web search failed.";
            }

            // Save both messages
            if (userUid && selectedMeeting?.meetingId) {
              const responseText = aiBubble.textContent || aiBubble.innerText;
              saveChatMessage(
                userUid,
                selectedMeeting.meetingId,
                "user",
                input
              );
              saveChatMessage(
                userUid,
                selectedMeeting.meetingId,
                "assistant",
                responseText
              );
            }

            isProcessing = false;
            scrollToBottom(true);
            return;
          }

          // --- Otherwise: your normal RAG flow ---
          const intent = analyzeQuestionIntent(input);
          console.log(`🎯 Detected intent: ${intent}`);

          if (intent === "drive_files" || isDriveFileListRequest(input)) {
            await handleDriveFilesQuery(input, aiBubble);
          } else if (intent === "file_search" || intent === "search_files") {
            await handleFileSearchQuery(input, aiBubble);
          } else {
            aiBubble.innerHTML =
              '<div class="typing-indicator">🔍 Searching knowledge base...</div>';

            const tw = makeTypewriter(aiBubble, { wps: 9 });

            const streamingGetAI = (messages) =>
              getAIResponse(messages, {
                onToken: (t) => tw.onToken(t),
              });

            const ragResponse = await getRAGResponseWithContext(
              input,
              selectedMeeting,
              userUid,
              filesContentMap,
              streamingGetAI
            );

            await tw.finish(ragResponse.response);

            // Save history as before
            conversationHistory.push({
              role: "assistant",
              content: ragResponse.response,
            });
            if (conversationHistory.length > MAX_CONVERSATION_HISTORY * 2) {
              conversationHistory = conversationHistory.slice(
                -MAX_CONVERSATION_HISTORY * 2
              );
            }

            if (ragResponse.hasResults) {
              const contextInfo = document.createElement("div");
              contextInfo.style.cssText =
                "font-size: 0.8em; color: #666; margin-top: 8px; font-style: italic;";
              contextInfo.innerHTML = `✨ Found ${ragResponse.searchResults.length} relevant documents`;
              aiBubble.appendChild(contextInfo);
            }

            if (voiceReplyToggle && voiceReplyToggle.checked && synth) {
              console.log("🔊 Voice reply enabled, speaking response");
              setTimeout(
                () =>
                  speakResponse(ragResponse.response || aiBubble.textContent),
                500
              );
            }
          }

          // Save to chat history
          if (userUid && selectedMeeting?.meetingId) {
            const responseText = aiBubble.textContent || aiBubble.innerText;
            saveChatMessage(userUid, selectedMeeting.meetingId, "user", input);
            saveChatMessage(
              userUid,
              selectedMeeting.meetingId,
              "assistant",
              responseText
            );
          }
        } catch (error) {
          console.error("Chat error:", error);
          aiBubble.innerHTML =
            "⚠️ Sorry, I encountered an error. Please try again.";
        }

        isProcessing = false;
        scrollToBottom(true);
      });

      function isDriveFileListRequest(query) {
        const queryLower = query.toLowerCase().trim();

        // More comprehensive patterns for Drive file requests
        const driveFilePatterns = [
          // Direct file listing requests
          /^(show|list|display|give me).*files?$/i,
          /^(show|list|display|give me).*documents?$/i,
          /^(show|list|display|give me).*drive.*files?$/i,
          /^what.*files?.*(do|are).*in.*(drive|folder)$/i,
          /^what.*documents?.*(do|are).*in.*(drive|folder)$/i,

          // More natural language patterns
          /\b(show|give|list|display|find|what).*\b(files?|documents?|drive)\b/i,
          /\bfiles? in\b.*\b(drive|folder)\b/i,
          /\bwhat.*inside.*drive\b/i,
          /\blist.*documents?\b/i,
          /\bshow.*folder\b/i,
          /\bdrive folder.*contents?\b/i,
          /\ball.*files?\b/i,
          /\bavailable.*files?\b/i,
          /\bfiles?.*uploaded\b/i,
          /\bfiles?.*available\b/i,

          // Question patterns
          /^what files/i,
          /^which files/i,
          /^any files/i,
          /^all files/i,
          /files in drive/i,
          /documents in folder/i,
        ];

        const isDriveRequest = driveFilePatterns.some((pattern) =>
          pattern.test(queryLower)
        );
        console.log(
          `🔍 Drive file request check: "${queryLower}" -> ${isDriveRequest}`
        );

        return isDriveRequest;
      }

      // Enhanced handleDriveFilesQuery function with proper error handling and fresh data
      async function handleDriveFilesQuery(input, aiBubble) {
        console.log("📁 Handling Drive files query:", input);

        if (!selectedMeeting?.driveFolderLink) {
          aiBubble.innerHTML =
            "⚠️ No Drive folder linked to this meeting. Please add a Drive folder link in the meeting settings.";
          return;
        }

        const folderId = extractFolderId(selectedMeeting.driveFolderLink);
        if (!folderId) {
          aiBubble.innerHTML =
            "⚠️ Could not extract folder ID from Drive link. Please check the folder link format.";
          return;
        }

        try {
          aiBubble.innerHTML =
            '<div class="typing-indicator">📁 Accessing your Drive folder (checking for new files)...</div>';

          // Get fresh auth token
          const token = await getAuthToken();
          console.log("✅ Got auth token");

          // ALWAYS force refresh to check for new files
          console.log(
            "🔄 Force refreshing Drive folder to check for new files..."
          );
          const files = await getFreshFileList(folderId, token, true); // Force refresh = true

          console.log(`📂 Found ${files.length} total files`);

          if (files.length === 0) {
            aiBubble.innerHTML = `📂 Your Drive folder appears to be empty or contains no accessible files.<br><br>
        <strong>Folder:</strong> <a href="${selectedMeeting.driveFolderLink}" target="_blank" rel="noopener noreferrer">Open in Google Drive</a><br><br>
        <em>If you just added files, they should appear now. If not, please check folder permissions.</em>`;
            return;
          }

          // Group files by type for better organization
          const filesByType = {};
          files.forEach((file) => {
            const type = getFileTypeCategory(file.mimeType);
            if (!filesByType[type]) filesByType[type] = [];
            filesByType[type].push(file);
          });

          // Build comprehensive response
          let response = `📁 <strong>Your Drive Folder Contents (${files.length} files)</strong><br><br>`;

          // Add timestamp to show freshness
          response += `<small>🕐 <em>Refreshed: ${new Date().toLocaleString()}</em></small><br><br>`;

          // List files by category
          for (const [type, typeFiles] of Object.entries(filesByType)) {
            response += `<strong>${type} (${typeFiles.length}):</strong><br>`;

            typeFiles.forEach((file, index) => {
              const sizeDisplay = file.displaySize || "Unknown size";
              const modifiedDate = file.modifiedTime
                ? new Date(file.modifiedTime).toLocaleDateString()
                : "";
              const dateStr = modifiedDate
                ? ` • Modified: ${modifiedDate}`
                : "";

              response += `${index + 1}. <a href="${file.webViewLink
                }" target="_blank" rel="noopener noreferrer">${file.name
                }</a> <small>(${sizeDisplay}${dateStr})</small><br>`;
            });
            response += "<br>";
          }

          // Add helpful footer
          response += `<hr style="margin: 15px 0; border: none; border-top: 1px solid #eee;">`;
          response += `<small>💡 <strong>Tip:</strong> You can ask me about specific files or search within their content!</small><br>`;
          response += `<small>🔗 <a href="${selectedMeeting.driveFolderLink}" target="_blank" rel="noopener noreferrer">Open folder in Google Drive</a></small>`;

          aiBubble.innerHTML = response;
          console.log("✅ Successfully displayed Drive files");
          scrollToBottom(true);
        } catch (err) {
          console.error("Drive API error:", err);

          let errorResponse = "";
          if (err && (err.status === 403 || err.message.includes("403"))) {
            errorResponse = `⚠️ <strong>Access Denied to Drive Folder</strong><br><br>
        This could mean:<br>
        • You don't have permission to view this folder<br>
        • The folder has been moved or deleted<br>
        • The sharing settings have changed<br>
        • Your authentication has expired<br><br>
        <strong>Try these solutions:</strong><br>
        1. <a href="${selectedMeeting.driveFolderLink}" target="_blank" rel="noopener noreferrer">Open the folder directly in Google Drive</a><br>
        2. Refresh this page to re-authenticate<br>
        3. Check that the folder is shared with your account<br><br>
        <small><em>Error: ${err.message}</em></small>`;
          } else if (
            err &&
            (err.status === 404 || err.message.includes("404"))
          ) {
            errorResponse = `⚠️ <strong>Drive Folder Not Found</strong><br><br>
        The linked Drive folder could not be found.<br><br>
        Possible reasons:<br>
        • The folder was deleted or moved<br>
        • The folder ID in the link is incorrect<br>
        • You don't have access to this folder<br><br>
        <a href="${selectedMeeting.driveFolderLink}" target="_blank" rel="noopener noreferrer">Try opening the folder link</a>`;
          } else {
            errorResponse = `❌ <strong>Error Accessing Google Drive</strong><br><br>
        <strong>Error:</strong> ${err.message}<br><br>
        <strong>Please try:</strong><br>
        • Refreshing your browser<br>
        • Re-authorizing the extension<br>
        • Checking your internet connection<br><br>
        <a href="${selectedMeeting.driveFolderLink}" target="_blank" rel="noopener noreferrer">Open folder in Google Drive</a>`;
          }

          aiBubble.innerHTML = errorResponse;
          scrollToBottom(true);
        }
      }

      // Handle file search queries
      async function handleFileSearchQuery(input, aiBubble) {
        const keyword = extractSearchKeyword(input);
        const folderId = extractFolderId(selectedMeeting.driveFolderLink);

        if (!folderId) {
          aiBubble.innerHTML = "⚠️ Could not access Drive folder.";
          return;
        }

        try {
          aiBubble.innerHTML =
            '<div class="typing-indicator">🔍 Searching files...</div>';

          const token = await getAuthToken();

          // Search by filename
          const fileMatches = await searchFilesRecursively(
            folderId,
            keyword,
            token
          );

          // Search within file contents
          const contentMatches = await searchFilesContent(
            filesContentMap,
            input
          );

          let response = "";

          if (fileMatches.length > 0) {
            response += `📄 <strong>Files matching "${keyword}":</strong><br>`;
            fileMatches.slice(0, 5).forEach((file) => {
              response += `• <a href="${file.webViewLink}" target="_blank" rel="noopener noreferrer">${file.name}</a><br>`;
            });
            response += "<br>";
          }

          if (contentMatches.length > 0) {
            response += `📝 <strong>Content found in files:</strong><br>`;
            contentMatches.forEach((match) => {
              response += `<strong>${match.filename}</strong> (relevance: ${match.score})<br>`;
              match.contexts.forEach((ctx) => {
                response += `<blockquote>${ctx.text}</blockquote>`;
              });
              response += "<br>";
            });
          }

          if (fileMatches.length === 0 && contentMatches.length === 0) {
            response = `🔍 No files or content found matching "${keyword}"`;
          }

          aiBubble.innerHTML = response;

          if (userUid && selectedMeeting.meetingId) {
            const plainResponse = aiBubble.textContent || aiBubble.innerText;
            saveChatMessage(
              userUid,
              selectedMeeting.meetingId,
              "assistant",
              plainResponse
            );
          }
        } catch (error) {
          console.error("Search error:", error);
          aiBubble.innerHTML = "❌ Error searching files.";
        }
      }

      // Helper functions
      function getFileTypeCategory(mimeType) {
        if (mimeType.includes("document")) return "Documents";
        if (mimeType.includes("spreadsheet")) return "Spreadsheets";
        if (mimeType.includes("presentation")) return "Presentations";
        if (mimeType.includes("text")) return "Text Files";
        if (mimeType.includes("image")) return "Images";
        if (mimeType.includes("pdf")) return "PDFs";
        return "Other Files";
      }

      function extractSearchKeyword(input) {
        const patterns = [
          /find\s+"([^"]+)"/i,
          /search\s+for\s+"([^"]+)"/i,
          /look\s+for\s+"([^"]+)"/i,
          /find\s+([\w\s]+)/i,
          /search\s+for\s+([\w\s]+)/i,
          /look\s+for\s+([\w\s]+)/i,
        ];

        for (const pattern of patterns) {
          const match = input.match(pattern);
          if (match) return match[1].trim();
        }

        return input.replace(/\b(find|search|look)\b/gi, "").trim();
      }

      async function ensureFilesLoaded() {
        if (Object.keys(filesContentMap).length > 0) return;

        console.log("📁 Loading files on demand...");
        await preloadDriveFiles();
      }

      function speakResponse(text) {
        if (!synth) {
          console.warn("Speech synthesis not available");
          return;
        }

        // Cancel any ongoing speech
        if (synth.speaking) {
          synth.cancel();
        }

        // Clean text for speech
        const cleanText = cleanTextForSpeech(text);

        if (!cleanText || cleanText.length === 0) {
          console.warn("No text to speak");
          return;
        }

        console.log("🔊 Speaking:", cleanText.substring(0, 50) + "...");

        const utterance = new SpeechSynthesisUtterance(cleanText);

        // Voice settings
        utterance.lang = "en-US";
        utterance.rate = 0.9;
        utterance.pitch = 1;
        utterance.volume = 0.8;

        // Try to use a good voice
        const voices = synth.getVoices();
        const preferredVoice =
          voices.find(
            (voice) =>
              voice.lang.includes("en") &&
              (voice.name.includes("Google") ||
                voice.name.includes("Microsoft"))
          ) || voices.find((voice) => voice.lang.includes("en"));

        if (preferredVoice) {
          utterance.voice = preferredVoice;
        }

        // Event handlers
        utterance.onstart = () => {
          console.log("🔊 Started speaking");
          if (voiceReplyToggle) {
            voiceReplyToggle.style.color = "#4CAF50";
            voiceReplyToggle.style.animation = "pulse 1s infinite";
          }
        };

        utterance.onend = () => {
          console.log("🔊 Finished speaking");
          if (voiceReplyToggle) {
            voiceReplyToggle.style.color = "";
            voiceReplyToggle.style.animation = "";
          }
        };

        // IMPROVED ERROR HANDLER - Don't log interruption as error
        utterance.onerror = (event) => {
          if (event.error === "interrupted") {
            // This is expected when user turns off voice reply - don't show as error
            console.log("🔊 Speech interrupted by user");
          } else {
            // Only log actual errors
            console.error("🔊 Speech synthesis error:", event.error);
          }

          // Always reset visual indicators
          if (voiceReplyToggle) {
            voiceReplyToggle.style.color = "";
            voiceReplyToggle.style.animation = "";
          }
        };

        // ADDITIONAL: Add a check before speaking to ensure voice reply is still enabled
        if (voiceReplyToggle && !voiceReplyToggle.checked) {
          console.log("🔊 Voice reply disabled, not speaking");
          return;
        }

        // Speak the text
        synth.speak(utterance);
      }

      // Event listeners
      if (voiceReplyToggle) {
        voiceReplyToggle.addEventListener("change", (e) => {
          console.log("🔊 Voice reply toggled:", e.target.checked);

          if (!e.target.checked && synth && synth.speaking) {
            console.log("🔊 Stopping current speech due to toggle off");
            synth.cancel();

            // Reset visual indicators immediately
            if (voiceReplyToggle) {
              voiceReplyToggle.style.color = "";
              voiceReplyToggle.style.animation = "";
            }
          }
        });
      }

      if (sendBtn) {
        sendBtn.addEventListener("click", () => {
          if (isProcessing || !chatInput.value.trim()) return;
          chatInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter" })
          );
        });
      }

      if (micBtn) {
        micBtn.onclick = (e) => {
          e.preventDefault();

          if (!recognition) {
            console.error("Speech recognition not initialized");
            return;
          }

          if (isMicActive) {
            // Stop recognition
            console.log("🎤 Stopping speech recognition");
            recognition.stop();
          } else {
            // Start recognition
            console.log("🎤 Starting speech recognition");
            try {
              recognition.start();
            } catch (error) {
              console.error("Failed to start speech recognition:", error);

              // Reset button state
              micBtn.textContent = "🎤";
              micBtn.style.color = "";
              micBtn.style.animation = "";
              micBtn.title = "Speech recognition error. Click to try again.";
            }
          }
        };
      }

      window.addEventListener("beforeunload", () => {
        try {
          chrome.storage.local.remove("chatWindowId");
        } catch (e) {
          // Extension context invalidated - ignore
        }
      });

      function ensureVoicesLoaded() {
        if (synth && synth.getVoices().length === 0) {
          synth.addEventListener("voiceschanged", () => {
            console.log("🔊 Voices loaded:", synth.getVoices().length);
          });
        }
      }

      initSpeechRecognition();
      ensureVoicesLoaded();
    })
    .catch((error) => {
      console.error("Failed to initialize chat:", error);
    });
});

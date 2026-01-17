// ai-chat/rag-service.js
// RAG pipeline: embedding, search, context building

import { CONFIG } from "./config.js";

// ============================================
// Embedding Generation
// ============================================

/**
 * Generate embedding for text via backend
 */
export async function generateEmbedding(text) {
    if (!text || text.trim().length < 10) {
        console.log("⏭️ Skipping embedding for short text");
        return null;
    }

    try {
        const response = await fetch(`${CONFIG.SERVER_URL}/ai/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: text.slice(0, 8000) }),
        });

        if (!response.ok) {
            throw new Error(`Embedding failed: ${response.status}`);
        }

        const data = await response.json();
        return data.embedding;
    } catch (error) {
        console.error("Embedding error:", error);
        return null;
    }
}

// ============================================
// Vector Search
// ============================================

/**
 * Search Pinecone for relevant context
 */
export async function searchVectors(query, options = {}) {
    const {
        namespace = CONFIG.NAMESPACES.documents,
        topK = CONFIG.RAG.topK,
        signal,
    } = options;

    const embedding = await generateEmbedding(query);
    if (!embedding) {
        throw new Error("Failed to generate query embedding");
    }

    const response = await fetch(`${CONFIG.SERVER_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            queryEmbedding: embedding,
            topK,
            includeMetadata: true,
            namespace,
        }),
        signal,
    });

    if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
    }

    return response.json();
}

/**
 * Search across multiple namespaces
 */
export async function searchMultipleNamespaces(query, namespaces, options = {}) {
    const { signal } = options;

    const searches = namespaces.map((ns) =>
        searchVectors(query, { ...options, namespace: ns, signal }).catch(() => [])
    );

    const results = await Promise.all(searches);

    // Merge and dedupe results
    const merged = results.flat();
    return deduplicateResults(merged);
}

// ============================================
// Context Building
// ============================================

/**
 * Extract keywords from query
 */
function extractKeywords(query, maxKeywords = 10) {
    const stopwords = new Set([
        "the", "is", "are", "a", "an", "of", "and", "in", "to", "about",
        "on", "for", "with", "who", "what", "when", "where", "why", "how",
        "tell", "me", "can", "you", "please", "would", "could", "should",
    ]);

    const words = query.toLowerCase().match(/[a-z0-9]+/g) || [];
    const freq = new Map();

    for (const word of words) {
        if (!stopwords.has(word) && word.length > 2) {
            freq.set(word, (freq.get(word) || 0) + 1);
        }
    }

    return [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxKeywords)
        .map(([word]) => word);
}

/**
 * Score and trim snippet to relevant sentences
 */
function trimToRelevant(text, keywords, maxSentences = 4) {
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);

    const scored = sentences.map((sentence) => {
        const lower = sentence.toLowerCase();
        let score = 0;
        for (const kw of keywords) {
            if (lower.includes(kw)) score++;
        }
        return { sentence, score };
    });

    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSentences)
        .map((s) => s.sentence)
        .join(" ");
}

/**
 * Deduplicate search results
 */
function deduplicateResults(results) {
    const seen = new Set();
    const unique = [];

    for (const result of results) {
        const key = (result.metadata?.filename || result.filename || "unknown") +
            "|" + (result.content || result.metadata?.content || "").slice(0, 100);

        if (!seen.has(key)) {
            seen.add(key);
            unique.push(result);
        }
    }

    return unique.sort((a, b) => (b.score || 0) - (a.score || 0));
}

/**
 * Build context from search results
 */
export function buildContext(results, query, options = {}) {
    const { maxTokens = CONFIG.RAG.maxContextTokens } = options;
    const keywords = extractKeywords(query);

    const snippets = [];
    let estimatedTokens = 0;

    for (const result of results) {
        const content = result.content || result.metadata?.content || "";
        if (!content) continue;

        const trimmed = trimToRelevant(content, keywords);
        const tokens = estimateTokens(trimmed);

        if (estimatedTokens + tokens > maxTokens) break;

        snippets.push({
            id: result.id,
            source: result.metadata?.filename || result.filename || "Document",
            text: trimmed,
            score: result.score || 0,
        });

        estimatedTokens += tokens;
    }

    return snippets;
}

/**
 * Estimate token count (rough)
 */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

// ============================================
// Full RAG Query
// ============================================

/**
 * Perform full RAG search and context building
 */
export async function ragQuery(query, meetingId, options = {}) {
    const { signal } = options;

    // Build namespace list - meeting namespace first (highest priority)
    const namespaces = [];

    if (meetingId) {
        namespaces.push(CONFIG.NAMESPACES.getMeetingNs(meetingId));
    }

    namespaces.push(CONFIG.NAMESPACES.documents);
    namespaces.push(CONFIG.NAMESPACES.web);

    console.log(`🔍 RAG Search: "${query}" in namespaces:`, namespaces);

    // Search across namespaces
    const results = await searchMultipleNamespaces(query, namespaces, { signal });
    console.log(`📊 Total results from search: ${results.length}`);

    // Log top results for debugging
    if (results.length > 0) {
        console.log("📄 Top results:", results.slice(0, 3).map(r => ({
            score: r.score?.toFixed(3),
            file: r.metadata?.filename,
            text: (r.metadata?.content || "").slice(0, 100)
        })));
    }

    // Filter by threshold (lowered to 0.5 for better recall)
    const threshold = 0.5;
    const filtered = results.filter(
        (r) => (r.score || 0) >= threshold
    );
    console.log(`✅ Filtered results (score >= ${threshold}): ${filtered.length}`);

    // Build context
    const context = buildContext(filtered, query);

    return {
        snippets: context,
        totalResults: results.length,
        filteredResults: filtered.length,
    };
}

// ============================================
// Prompt Building
// ============================================

/**
 * Build system prompt with context
 */
export function buildPrompt(query, snippets, conversationHistory = []) {
    const hasContext = snippets && snippets.length > 0;

    const contextText = hasContext
        ? snippets.map((s, i) => `[${i + 1}] ${s.text} — ${s.source}`).join("\n\n")
        : "";

    let systemContent;

    if (hasContext) {
        // Get unique source file names
        const sourceFiles = [...new Set(snippets.map(s => s.source))];

        // When we have relevant context, prioritize it
        systemContent = `You are a helpful AI assistant. Answer questions using the provided context from the user's documents.

CONTEXT FROM DOCUMENTS:
${contextText}

INSTRUCTIONS:
- Answer using the information from the documents above
- Do NOT use inline citations like [1], [2], etc. in your response
- Write a natural, flowing response without citation markers
- At the END of your response, add a blank line and then list the sources like this:
  📄 Sources: ${sourceFiles.join(", ")}
- Be concise and accurate`;
    } else {
        // When no context is found - tell user to sync files
        systemContent = `You are an AI assistant that ONLY answers from the user's documents.

No relevant information was found in the indexed documents for this question.

Please tell the user:
1. No relevant content was found in their indexed files
2. They should check if their Google Drive folder has been synced
3. They can click the sync button to index their files
4. Ask them to try again after syncing`;
    }

    const systemMessage = {
        role: "system",
        content: systemContent,
    };

    const messages = [
        systemMessage,
        ...conversationHistory.slice(-6), // Last 6 messages for context
        { role: "user", content: query },
    ];

    return messages;
}

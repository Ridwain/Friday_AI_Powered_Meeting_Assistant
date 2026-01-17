// services/rag.js
// RAG service for embedding, chunking, and search

// ============================================
// Text Chunking
// ============================================

/**
 * Split text into overlapping chunks
 */
export function chunkText(text, chunkSize = 1000, overlap = 100) {
    const chunks = [];
    let i = 0;

    while (i < text.length) {
        const end = Math.min(i + chunkSize, text.length);
        chunks.push(text.slice(i, end));
        if (end === text.length) break;
        i = end - overlap;
    }

    return chunks;
}

/**
 * Create chunks with metadata
 */
export function createChunks(text, filename, meetingId) {
    const rawChunks = chunkText(text);

    return rawChunks.map((content, index) => ({
        id: `${meetingId}_${filename}_${index}`,
        content,
        metadata: {
            filename,
            meetingId,
            chunkIndex: index,
            wordCount: content.split(/\s+/).length,
            createdAt: new Date().toISOString(),
        },
    }));
}

// ============================================
// Vector Operations
// ============================================

/**
 * Create vector from chunk for Pinecone upsert
 */
export function createVector(chunk, embedding) {
    return {
        id: chunk.id,
        values: embedding,
        metadata: {
            ...chunk.metadata,
            content: chunk.content.slice(0, 1000), // Limit metadata size
        },
    };
}

// ============================================
// Result Processing
// ============================================

/**
 * Filter results by similarity threshold
 */
export function filterByThreshold(results, threshold = 0.7) {
    return results.filter((r) => (r.score || 0) >= threshold);
}

/**
 * Deduplicate results by content similarity
 */
export function deduplicateResults(results) {
    const seen = new Set();
    const unique = [];

    for (const result of results) {
        const key = `${result.metadata?.filename || "unknown"}|${(result.content || result.metadata?.content || "").slice(0, 100)}`;

        if (!seen.has(key)) {
            seen.add(key);
            unique.push(result);
        }
    }

    return unique.sort((a, b) => (b.score || 0) - (a.score || 0));
}

/**
 * Merge results from multiple namespace searches
 */
export function mergeResults(resultArrays, maxResults = 10) {
    const all = resultArrays.flat();
    const deduped = deduplicateResults(all);
    return deduped.slice(0, maxResults);
}

// ============================================
// Context Building
// ============================================

/**
 * Build context string from results
 */
export function buildContext(results, maxTokens = 6000) {
    let context = "";
    let estimatedTokens = 0;

    for (const result of results) {
        const content = result.content || result.metadata?.content || "";
        const tokens = Math.ceil(content.length / 4);

        if (estimatedTokens + tokens > maxTokens) break;

        context += `[${result.metadata?.filename || "Document"}]\n${content}\n\n`;
        estimatedTokens += tokens;
    }

    return context.trim();
}

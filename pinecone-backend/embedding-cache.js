// embedding-cache.js
// LRU Cache for embeddings to avoid redundant API calls

/**
 * Simple LRU Cache implementation for embeddings
 */
export class EmbeddingCache {
    constructor(options = {}) {
        this.maxSize = options.maxSize || 1000;
        this.ttl = options.ttl || 3600000; // 1 hour default TTL
        this.cache = new Map();
        this.hits = 0;
        this.misses = 0;

        // Cleanup expired entries periodically
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, Math.min(this.ttl, 300000)); // Every 5 minutes or TTL, whichever is smaller
    }

    /**
     * Generate a cache key from text
     * @param {string} text - Text to generate key for
     * @returns {string} - Cache key
     */
    generateKey(text) {
        // Simple hash function for cache key
        let hash = 0;
        const str = text.trim().toLowerCase();
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return `emb_${hash}_${str.length}`;
    }

    /**
     * Get an embedding from cache
     * @param {string} text - Text to look up
     * @returns {number[]|null} - Cached embedding or null
     */
    get(text) {
        const key = this.generateKey(text);
        const entry = this.cache.get(key);

        if (!entry) {
            this.misses++;
            return null;
        }

        // Check if expired
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.misses++;
            return null;
        }

        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, entry);

        this.hits++;
        return entry.embedding;
    }

    /**
     * Store an embedding in cache
     * @param {string} text - Text that was embedded
     * @param {number[]} embedding - The embedding vector
     */
    set(text, embedding) {
        const key = this.generateKey(text);

        // If at max size, remove oldest entry (first in map)
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, {
            embedding,
            expiresAt: Date.now() + this.ttl,
            textLength: text.length,
        });
    }

    /**
     * Check if text is in cache
     * @param {string} text - Text to check
     * @returns {boolean}
     */
    has(text) {
        const key = this.generateKey(text);
        const entry = this.cache.get(key);
        return entry && Date.now() <= entry.expiresAt;
    }

    /**
     * Remove expired entries
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`🧹 Embedding cache cleanup: removed ${cleaned} expired entries`);
        }
    }

    /**
     * Get cache statistics
     * @returns {Object} - Cache stats
     */
    getStats() {
        const total = this.hits + this.misses;
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.hits,
            misses: this.misses,
            hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(2) + '%' : '0%',
        };
    }

    /**
     * Clear the entire cache
     */
    clear() {
        const size = this.cache.size;
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
        return size;
    }

    /**
     * Destroy the cache (cleanup interval)
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.clear();
    }
}

// Export a singleton instance for shared use
export const sharedEmbeddingCache = new EmbeddingCache({
    maxSize: parseInt(process.env.EMBEDDING_CACHE_MAX_SIZE) || 1000,
    ttl: 3600000, // 1 hour
});

export default EmbeddingCache;

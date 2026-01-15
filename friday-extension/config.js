// config.js - Centralized configuration for the Friday extension
// Change SERVER_URL to your production server when deploying.

const CONFIG = {
    // Backend server URL - change this when deploying to production
    SERVER_URL: "http://localhost:3000",

    // RAG (Retrieval-Augmented Generation) settings
    RAG: {
        MAX_RESULTS: 3,
        SIMILARITY_THRESHOLD: 0.7,
        SEARCH_TIMEOUT_MS: 1000,
        FAST_HIT_THRESHOLD: 0.88,
    },

    // Conversation settings
    CONVERSATION: {
        MAX_HISTORY: 10,
    },

    // Cache keys
    CACHE_KEYS: {
        UPLOAD_TRACKER: "ragUploadedFilesV2",
        WEB_UPSERTS: "webUrlUpserts",
    },
};

// Export for ES modules
export { CONFIG };

// Also make available globally for non-module scripts
if (typeof window !== "undefined") {
    window.FRIDAY_CONFIG = CONFIG;
}

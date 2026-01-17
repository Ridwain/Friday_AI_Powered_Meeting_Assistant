// ai-chat/config.js
// Centralized configuration for the AI chat system

export const CONFIG = {
  // Backend server URL
  SERVER_URL: "http://localhost:3000",

  // RAG (Retrieval-Augmented Generation) settings
  RAG: {
    topK: 5,                      // Number of results to retrieve
    similarityThreshold: 0.7,     // Minimum similarity score
    maxContextTokens: 6000,       // Max tokens for context
    searchTimeoutMs: 8000,        // Search timeout
    chunkSize: 1000,              // Text chunk size for indexing
    chunkOverlap: 100,            // Overlap between chunks
  },

  // LLM settings
  LLM: {
    model: "gemini-2.5-flash-lite",
    temperature: 0.4,
    maxTokens: 2048,
  },

  // UI settings
  UI: {
    typewriterSpeed: 5,          // Words per second (slower for readability)
    maxVisibleMessages: 50,       // Messages to render in DOM
    scrollBehavior: "smooth",
  },

  // Storage keys
  STORAGE_KEYS: {
    chatCache: "aiChatCache",
    indexedFiles: "aiIndexedFiles",
    userPrefs: "aiChatPrefs",
  },

  // Namespaces for Pinecone
  NAMESPACES: {
    documents: "siat",
    web: "web",
    getMeetingNs: (meetingId) => `meeting:${meetingId}`,
  },
};

// Make available globally for non-module scripts
if (typeof window !== "undefined") {
  window.AI_CHAT_CONFIG = CONFIG;
}

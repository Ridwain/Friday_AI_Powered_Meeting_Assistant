// ai-chat/index.js
// Entry point - initializes all modules and sets up event listeners

import { CONFIG } from "./config.js";
import * as chatController from "./chat-controller.js";
import * as chatUI from "./chat-ui.js";
import * as storageService from "./storage-service.js";
import * as driveService from "./drive-service.js";

// ============================================
// Initialization
// ============================================

let initialized = false;

/**
 * Initialize the AI chat system
 */
export async function init() {
    if (initialized) return;
    initialized = true; // Set early to prevent double init

    console.log("🚀 Initializing AI Chat System...");

    // Initialize UI with DOM elements immediately
    chatUI.initUI({
        chatContainer: document.getElementById("chat-messages"),
        inputField: document.getElementById("chat-input"),
        sendButton: document.getElementById("send-btn"),
    });

    // Set up event listeners
    setupEventListeners();

    // Listen for session changes
    storageService.onSessionChange(handleSessionChange);

    // Defer session check to allow UI to render first
    requestAnimationFrame(() => {
        storageService.getSessionState().then(handleSessionChange);
    });

    // Initialize theme
    initThemeSync();

    console.log("✅ AI Chat System initialized");
}

/**
 * Initialize theme synchronization
 */
function initThemeSync() {
    const THEME_KEY = "friday_theme_preference";

    // 1. Load saved theme
    if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([THEME_KEY], (result) => {
            const theme = result[THEME_KEY] || "dark";
            document.documentElement.setAttribute("data-theme", theme);
        });

        // 2. Listen for changes (sync with popup/dashboard)
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes[THEME_KEY]) {
                const newTheme = changes[THEME_KEY].newValue;
                document.documentElement.setAttribute("data-theme", newTheme);
            }
        });
    }
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // Send button click
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) {
        sendBtn.addEventListener("click", handleSend);
    }

    // Enter key to send
    const input = document.getElementById("chat-input");
    if (input) {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });
    }

    // Stop button (if exists)
    const stopBtn = document.getElementById("stop-btn");
    if (stopBtn) {
        stopBtn.addEventListener("click", () => {
            chatController.cancelRequest();
        });
    }

    // Regenerate button (if exists)
    const regenBtn = document.getElementById("regenerate-btn");
    if (regenBtn) {
        regenBtn.addEventListener("click", () => {
            chatController.regenerateLastResponse();
        });
    }

    // Sync button - sync Drive files
    const syncBtn = document.getElementById("sync-btn");
    if (syncBtn) {
        syncBtn.addEventListener("click", handleSync);
    }

    // Load More button - use event delegation since it's dynamically created
    const chatMessages = document.getElementById("chat-messages");
    if (chatMessages) {
        chatMessages.addEventListener("click", (e) => {
            if (e.target.closest(".load-more-btn")) {
                chatController.loadMoreMessages();
            }
        });
    }
}

// ============================================
// Handlers
// ============================================

let currentMeeting = null;

async function handleSend() {
    const input = document.getElementById("chat-input");
    if (!input) return;

    const query = input.value.trim();
    if (!query) return;

    await chatController.sendMessage(query);
}

async function handleSync() {
    if (!currentMeeting) {
        alert("No meeting selected");
        return;
    }

    const syncStatus = document.getElementById("sync-status");
    const syncText = syncStatus?.querySelector(".sync-text");
    const syncBtn = document.getElementById("sync-btn");

    // Show sync status
    syncStatus?.classList.remove("hidden");
    if (syncBtn) syncBtn.disabled = true;

    try {
        const result = await driveService.syncMeetingFiles(currentMeeting, (msg) => {
            if (syncText) syncText.textContent = msg;
        });

        if (result.error) {
            if (syncText) syncText.textContent = `Sync failed: ${result.error}`;
        } else {
            if (syncText) syncText.textContent = `Synced ${result.synced} files`;
        }

        // Hide after 3 seconds
        setTimeout(() => {
            syncStatus?.classList.add("hidden");
        }, 3000);

    } catch (error) {
        console.error("Sync error:", error);
        if (syncText) syncText.textContent = `Error: ${error.message}`;
    } finally {
        if (syncBtn) syncBtn.disabled = false;
    }
}

// Debounce guard for handleSessionChange
let sessionChangeTimeout = null;
let lastProcessedMeetingId = null;

async function handleSessionChange(session) {
    const { uid, meeting, active } = session;

    if (!active || !meeting) {
        // No active session - show welcome
        currentMeeting = null;
        lastProcessedMeetingId = null;
        chatController.reset();
        return;
    }

    // DEBOUNCE: Skip if we just processed the same meeting
    if (lastProcessedMeetingId === meeting.meetingId) {
        console.log(`⏭️ [Debounce] Skipping duplicate session change for ${meeting.meetingId}`);
        return;
    }

    // Clear any pending timeout
    if (sessionChangeTimeout) {
        clearTimeout(sessionChangeTimeout);
    }

    // Debounce: Wait 50ms before processing to batch rapid changes
    sessionChangeTimeout = setTimeout(() => {
        lastProcessedMeetingId = meeting.meetingId;
        currentMeeting = meeting;

        // Initialize chat with meeting (non-blocking)
        console.log(`📋 Loading chat for meeting: ${meeting.meetingId}`);
        chatController.init(meeting.meetingId, uid);

        // Auto-sync Drive files in background (delayed to not compete with init)
        setTimeout(() => {
            driveService.autoSync(meeting).catch((e) => {
                console.warn("Auto-sync failed:", e);
            });
        }, 500);
    }, 50);
}

// ============================================
// Public API
// ============================================

export { chatController, chatUI, storageService, driveService };

export function getConfig() {
    return CONFIG;
}

// ============================================
// Auto-init when DOM is ready
// ============================================

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}

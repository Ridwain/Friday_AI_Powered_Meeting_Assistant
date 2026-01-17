// ai-chat/storage-service.js
// Handles Chrome storage, Firestore, and caching

import { CONFIG } from "./config.js";
import { db } from "../firebase-config.js";
import {
    collection,
    addDoc,
    getDocs,
    query,
    orderBy,
    limit,
    limitToLast,
    startAfter,
    endBefore,
    serverTimestamp
} from "../firebase/firebase-firestore.js";

// ============================================
// Chrome Storage Operations
// ============================================

/**
 * Get value from chrome.storage.local
 */
export async function getLocal(key) {
    return new Promise((resolve) => {
        chrome.storage.local.get(key, (result) => {
            resolve(result[key] ?? null);
        });
    });
}

/**
 * Set value in chrome.storage.local
 */
export async function setLocal(key, value) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [key]: value }, resolve);
    });
}

/**
 * Remove value from chrome.storage.local
 */
export async function removeLocal(key) {
    return new Promise((resolve) => {
        chrome.storage.local.remove(key, resolve);
    });
}

// ============================================
// Chat History Cache
// ============================================

/**
 * Get cached chat history for a meeting
 */
export async function getChatCache(meetingId) {
    const key = `${CONFIG.STORAGE_KEYS.chatCache}_${meetingId}`;
    return getLocal(key);
}

/**
 * Save chat history to cache
 */
export async function setChatCache(meetingId, messages) {
    const key = `${CONFIG.STORAGE_KEYS.chatCache}_${meetingId}`;
    // Limit cache size
    const limited = messages.slice(-200);
    return setLocal(key, limited);
}

/**
 * Clear chat cache for a meeting
 */
export async function clearChatCache(meetingId) {
    const key = `${CONFIG.STORAGE_KEYS.chatCache}_${meetingId}`;
    return removeLocal(key);
}

// ============================================
// Indexed Files Tracker
// ============================================

/**
 * Get list of indexed files for a meeting
 */
export async function getIndexedFiles(meetingId) {
    const all = await getLocal(CONFIG.STORAGE_KEYS.indexedFiles) || {};
    return all[meetingId] || {};
}

/**
 * Mark file as indexed
 */
export async function markFileIndexed(meetingId, fileId, modifiedTime) {
    const all = await getLocal(CONFIG.STORAGE_KEYS.indexedFiles) || {};
    if (!all[meetingId]) all[meetingId] = {};
    all[meetingId][fileId] = modifiedTime;
    return setLocal(CONFIG.STORAGE_KEYS.indexedFiles, all);
}

/**
 * Check if file needs re-indexing
 */
export async function needsReindex(meetingId, fileId, currentModifiedTime) {
    const indexed = await getIndexedFiles(meetingId);
    return !indexed[fileId] || indexed[fileId] !== currentModifiedTime;
}

// ============================================
// Firestore Operations
// ============================================

/**
 * Load chat history from Firestore with pagination
 * @param {string} uid - User ID
 * @param {string} meetingId - Meeting ID
 * @param {Object} options - Pagination options
 * @param {number} options.pageSize - Number of messages to load (default 200)
 * @param {Object} options.beforeTimestamp - Load messages before this timestamp
 * @returns {Object} { messages, hasMore, oldestTimestamp }
 */
export async function loadChatHistory(uid, meetingId, options = {}) {
    const { pageSize = 200, beforeTimestamp = null } = options;

    const chatRef = collection(db, "users", uid, "meetings", meetingId, "chats");

    let q;
    if (beforeTimestamp) {
        // Load older messages before the cursor
        q = query(
            chatRef,
            orderBy("timestamp", "desc"),
            startAfter(beforeTimestamp),
            limit(pageSize)
        );
    } else {
        // Load latest messages
        q = query(
            chatRef,
            orderBy("timestamp", "desc"),
            limit(pageSize)
        );
    }

    const snapshot = await getDocs(q);

    const messages = [];
    let oldestTimestamp = null;

    snapshot.forEach((doc) => {
        const data = doc.data();
        const timestamp = data.timestamp?.toDate?.() || new Date();

        messages.push({
            id: doc.id,
            role: data.role,
            content: data.content,
            timestamp: timestamp.toISOString(),
            _firestoreTimestamp: data.timestamp, // Keep for pagination cursor
        });

        // In DESC order, each iteration is an older message
        // So the last one processed is the oldest
        oldestTimestamp = data.timestamp;
    });

    // Reverse to get chronological order (oldest first)
    messages.reverse();

    console.log(`📊 Loaded ${messages.length} messages, hasMore: ${snapshot.size === pageSize}`);

    return {
        messages,
        hasMore: snapshot.size === pageSize,
        oldestTimestamp,
    };
}

/**
 * Save message to Firestore
 */
export async function saveMessage(uid, meetingId, role, content) {
    const chatRef = collection(db, "users", uid, "meetings", meetingId, "chats");
    const docRef = await addDoc(chatRef, {
        role,
        content,
        timestamp: serverTimestamp(),
    });

    return docRef.id;
}

// ============================================
// Session State
// ============================================

/**
 * Get current session state
 */
export async function getSessionState() {
    const [uid, meeting, active] = await Promise.all([
        getLocal("uid"),
        getLocal("selectedMeetingForChat"),
        getLocal("chatSessionActive"),
    ]);

    return { uid, meeting, active };
}

/**
 * Listen for session changes
 */
export function onSessionChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;

        if (changes.selectedMeetingForChat || changes.chatSessionActive || changes.uid) {
            getSessionState().then(callback);
        }
    });
}

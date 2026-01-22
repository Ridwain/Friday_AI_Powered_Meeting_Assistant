// ai-chat/chat-controller.js
// Message handling, conversation flow, streaming

import { CONFIG } from "./config.js";
import * as ragService from "./rag-service.js";
import * as storageService from "./storage-service.js";
import * as chatUI from "./chat-ui.js";

// ============================================
// State
// ============================================

let conversationHistory = [];
let currentMeetingId = null;
let currentUserId = null;
let abortController = null;

// Pagination state
let paginationCursor = null; // Oldest message timestamp for loading more
let hasMoreMessages = false;
let isLoadingMore = false;

// ============================================
// Initialization
// ============================================

/**
 * Initialize chat controller
 * Implements "Smart Initialization" - skips destructive reload if already on the same meeting
 */
export function init(meetingId, userId) {
    // ========================================
    // SMART INIT CHECK: Are we already on this meeting?
    // ========================================
    if (currentMeetingId === meetingId && currentUserId === userId) {
        console.log(`⚡ [Smart Init] Already active on meeting ${meetingId}. Skipping destructive reload.`);
        // Silent background refresh - checks for new messages without wiping UI
        loadFromFirestore(userId, meetingId, { silent: true });
        return;
    }

    // ========================================
    // NEW SESSION: Full initialization required
    // ========================================
    currentMeetingId = meetingId;
    currentUserId = userId;

    // Reset pagination state
    paginationCursor = null;
    hasMoreMessages = false;
    isLoadingMore = false;

    // Clear messages and show loading immediately
    chatUI.clearMessages();
    chatUI.showLoading("Loading chat history...");

    // Load everything in background - don't block
    setTimeout(() => {
        loadChatData(userId, meetingId);
    }, 0);
}

/**
 * Load chat data (cache first, then Firestore)
 */
async function loadChatData(userId, meetingId) {
    try {
        // Try cache first
        const cached = await storageService.getChatCache(meetingId);
        const hasCachedData = cached && cached.length > 0;

        if (hasCachedData) {
            chatUI.hideLoading();
            conversationHistory = cached;
            // Show Load More button first (before render to avoid layout shift)
            chatUI.setLoadMoreVisible(cached.length > CONFIG.UI.maxVisibleMessages);
            // Use instant render (hides scroll operation from user - WhatsApp style)
            chatUI.renderMessagesInstant(cached.slice(-CONFIG.UI.maxVisibleMessages));
            console.log(`⚡ Loaded ${cached.length} messages from cache`);
        }

        // Then load from Firestore
        // Use silent mode if cache was already rendered (prevents scroll jump)
        await loadFromFirestore(userId, meetingId, { silent: hasCachedData });
    } catch (error) {
        console.error("Failed to load chat data:", error);
        chatUI.hideLoading();
    }
}

/**
 * Load messages from Firestore in background
 * @param {string} userId - User ID
 * @param {string} meetingId - Meeting ID
 * @param {Object} options - Options
 * @param {boolean} options.silent - If true, skip UI clearing (for background refresh)
 */
async function loadFromFirestore(userId, meetingId, options = {}) {
    const { silent = false } = options;

    try {
        const result = await storageService.loadChatHistory(userId, meetingId, { pageSize: 200 });

        // In silent mode, only update if there are NEW messages
        if (silent) {
            const newMessageCount = result.messages.length - conversationHistory.length;
            if (newMessageCount > 0) {
                // Only append genuinely new messages
                const newMessages = result.messages.slice(-newMessageCount);
                console.log(`🔄 [Silent Refresh] Found ${newMessageCount} new message(s). Appending.`);
                for (const msg of newMessages) {
                    chatUI.appendMessage(msg.role, msg.content, msg.timestamp);
                }
                conversationHistory = result.messages;
                await storageService.setChatCache(meetingId, result.messages);
            } else {
                console.log(`🔄 [Silent Refresh] No new messages.`);
            }
            // Update pagination state silently (but DON'T update Load More button - causes layout shift)
            paginationCursor = result.oldestTimestamp;
            hasMoreMessages = result.hasMore;
            // NOTE: Skipping setLoadMoreVisible to prevent scroll jump from layout shift
            return;
        }

        // Standard (non-silent) mode: full re-render if data differs significantly
        conversationHistory = result.messages;
        paginationCursor = result.oldestTimestamp;
        hasMoreMessages = result.hasMore;

        // Show/hide load more button
        chatUI.setLoadMoreVisible(hasMoreMessages);

        // Only re-render if significantly different
        const cacheSize = (await storageService.getChatCache(meetingId))?.length || 0;
        if (Math.abs(result.messages.length - cacheSize) > 5) {
            chatUI.clearMessages();
            chatUI.renderMessages(result.messages.slice(-CONFIG.UI.maxVisibleMessages));
            chatUI.scrollToBottom(false);
        }

        // Update cache
        await storageService.setChatCache(meetingId, result.messages);
        console.log(`✅ Loaded ${result.messages.length} messages from Firestore (hasMore: ${hasMoreMessages})`);
    } catch (error) {
        console.error("Failed to load chat history:", error);
    }
}

/**
 * Load more older messages
 */
export async function loadMoreMessages() {
    if (!hasMoreMessages || isLoadingMore) {
        console.log("⚠️ Cannot load more:", { hasMoreMessages, isLoadingMore, paginationCursor: !!paginationCursor });
        return;
    }

    console.log("📜 Loading more messages, cursor:", paginationCursor);

    isLoadingMore = true;
    chatUI.setLoadMoreLoading(true);

    try {
        const result = await storageService.loadChatHistory(
            currentUserId,
            currentMeetingId,
            { pageSize: 50, beforeTimestamp: paginationCursor }
        );

        console.log("📜 Got result:", {
            count: result.messages.length,
            hasMore: result.hasMore,
            oldestTimestamp: result.oldestTimestamp
        });

        if (result.messages.length > 0) {
            // Prepend older messages
            conversationHistory = [...result.messages, ...conversationHistory];
            paginationCursor = result.oldestTimestamp;
            hasMoreMessages = result.hasMore;

            // Render older messages at top
            chatUI.renderMessages(result.messages, true); // prepend = true

            // Update cache
            await storageService.setChatCache(currentMeetingId, conversationHistory.slice(-200));
            console.log(`📜 Loaded ${result.messages.length} more messages`);
        } else {
            hasMoreMessages = false;
        }

        chatUI.setLoadMoreVisible(hasMoreMessages);
    } catch (error) {
        console.error("Failed to load more messages:", error);
    } finally {
        isLoadingMore = false;
        chatUI.setLoadMoreLoading(false);
    }
}

/**
 * Reset state
 */
export function reset() {
    conversationHistory = [];
    currentMeetingId = null;
    currentUserId = null;
    abortController = null;
    paginationCursor = null;
    hasMoreMessages = false;
    isLoadingMore = false;
    chatUI.clearMessages();
    chatUI.showWelcome();
}

// ============================================
// Message Handling
// ============================================

/**
 * Send a message and get AI response
 */
export async function sendMessage(query, options = {}) {
    if (!query.trim()) return;
    if (!currentMeetingId || !currentUserId) {
        chatUI.showError("No meeting selected");
        return;
    }

    // Cancel any ongoing request
    cancelRequest();

    // Add user message to UI
    const userTimestamp = new Date().toISOString();
    chatUI.appendMessage("user", query, userTimestamp);
    chatUI.clearInput();
    chatUI.setInputDisabled(true);

    // Add to history
    conversationHistory.push({ role: "user", content: query, timestamp: userTimestamp });

    // Save user message to Firestore
    storageService.saveMessage(currentUserId, currentMeetingId, "user", query).catch(console.error);

    try {
        abortController = new AbortController();
        const signal = abortController.signal;

        // Classify the query first
        const queryType = ragService.classifyQuery(query);
        console.log(`🏷️ Query classified as: ${queryType}`);

        let messages;

        if (queryType === 'greeting' || queryType === 'meta') {
            // Skip RAG for greetings and meta questions - respond conversationally
            chatUI.showLoading("Thinking...");
            messages = ragService.buildConversationalPrompt(query, queryType, conversationHistory);
            console.log(`💬 Using conversational prompt for ${queryType}`);

            if (signal.aborted) return;

            // Stream response for greetings/meta
            chatUI.hideLoading();
            const response = await streamResponse(messages, signal);

            if (signal.aborted) return;

            // Save assistant response
            const assistantTimestamp = new Date().toISOString();
            conversationHistory.push({ role: "assistant", content: response, timestamp: assistantTimestamp });

            // Update cache and save to Firestore
            await storageService.setChatCache(currentMeetingId, conversationHistory);
            storageService.saveMessage(currentUserId, currentMeetingId, "assistant", response).catch(console.error);
            return;
        } else {
            // Document question - use LangChain RAG Chat endpoint
            chatUI.showLoading("Searching documents with AI...");

            console.log("🔗 Using LangChain RAG Chat endpoint");

            // Call /chat endpoint which handles RAG + Memory internally
            const chatResponse = await fetch(`${CONFIG.SERVER_URL}/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: query,
                    session_id: currentMeetingId || "default",
                    meeting_id: currentMeetingId,
                    namespace: currentMeetingId ? `meeting:${currentMeetingId}` : "documents"
                }),
                signal,
            });

            if (!chatResponse.ok) {
                throw new Error(`Chat failed: ${chatResponse.status}`);
            }

            const result = await chatResponse.json();
            console.log("🎯 LangChain RAG Result:", result);

            if (signal.aborted) return;

            chatUI.hideLoading();

            // Display the answer with typewriter effect
            const typewriter = chatUI.createAssistantMessage();
            const answer = result.answer || "I couldn't find a relevant answer.";

            // Add sources if available
            let fullResponse = answer;
            // Sources hidden per user request

            typewriter.write(fullResponse);
            typewriter.finish();

            // Save assistant response
            const assistantTimestamp = new Date().toISOString();
            conversationHistory.push({ role: "assistant", content: fullResponse, timestamp: assistantTimestamp });

            // Update cache and save to Firestore
            await storageService.setChatCache(currentMeetingId, conversationHistory);
            storageService.saveMessage(currentUserId, currentMeetingId, "assistant", fullResponse).catch(console.error);
            return;
        }

        if (signal.aborted) return;

        // 4. Save assistant response
        const assistantTimestamp = new Date().toISOString();
        conversationHistory.push({ role: "assistant", content: response, timestamp: assistantTimestamp });

        // Update cache
        await storageService.setChatCache(currentMeetingId, conversationHistory);

        // Save to Firestore
        storageService.saveMessage(currentUserId, currentMeetingId, "assistant", response).catch(console.error);

    } catch (error) {
        if (error.name === "AbortError") {
            console.log("Request cancelled");
            return;
        }

        console.error("Chat error:", error);
        chatUI.hideLoading();
        chatUI.showError(error.message || "Failed to get response", () => sendMessage(query));
    } finally {
        chatUI.setInputDisabled(false);
        chatUI.focusInput();
        abortController = null;
    }
}

/**
 * Cancel ongoing request
 */
export function cancelRequest() {
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
}

// ============================================
// Streaming
// ============================================

/**
 * Stream LLM response
 */
async function streamResponse(messages, signal) {
    console.log("📡 Starting stream request to:", `${CONFIG.SERVER_URL}/ai/stream`);

    const response = await fetch(`${CONFIG.SERVER_URL}/ai/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            messages,
            model: CONFIG.LLM.model,
            temperature: CONFIG.LLM.temperature,
            maxTokens: CONFIG.LLM.maxTokens,
        }),
        signal,
    });

    console.log("📡 Stream response status:", response.status);

    if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Stream error:", errorText);
        throw new Error(`Stream failed: ${response.status}`);
    }

    // Create assistant message element
    const assistantEl = chatUI.appendMessage("assistant", "", new Date().toISOString());
    const bubbleEl = assistantEl.querySelector(".message-bubble");

    // Create typewriter
    const typewriter = chatUI.createTypewriter(bubbleEl);

    // Read stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = "";
    let chunkCount = 0;
    let incompleteBuffer = "";  // Buffer for incomplete SSE lines (handles split chunks)

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.log("📡 Stream done, total chunks:", chunkCount);
                break;
            }

            // Combine with previous incomplete data
            const chunk = incompleteBuffer + decoder.decode(value, { stream: true });
            chunkCount++;

            // Debug: log raw chunk data
            if (chunkCount <= 3) {
                console.log(`📦 Chunk ${chunkCount}:`, chunk.slice(0, 200));
            }

            const lines = chunk.split("\n");
            // Save last potentially incomplete line for next iteration
            incompleteBuffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;

                const data = line.slice(6);
                if (data === "[DONE]") continue;

                try {
                    const parsed = JSON.parse(data);

                    // Handle Gemini format
                    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
                    if (text) {
                        fullResponse += text;
                        typewriter.write(text);
                    }

                    // Handle error
                    if (parsed.error) {
                        console.error("❌ Stream error in data:", parsed.error);
                        throw new Error(parsed.error);
                    }
                } catch (e) {
                    // Skip non-JSON lines - but log the first few
                    if (chunkCount <= 3 && data.length > 0) {
                        console.log("⚠️ Non-JSON data:", data.slice(0, 100));
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    console.log("📝 Final response length:", fullResponse.length, "chars");

    // Finish typewriter
    typewriter.finish();

    return fullResponse || typewriter.getContent();
}

// ============================================
// Regenerate
// ============================================

/**
 * Regenerate last response
 */
export async function regenerateLastResponse() {
    // Find last user message
    const lastUserIndex = conversationHistory.findLastIndex((m) => m.role === "user");
    if (lastUserIndex === -1) return;

    const lastQuery = conversationHistory[lastUserIndex].content;

    // Remove last assistant response from history
    if (conversationHistory[conversationHistory.length - 1]?.role === "assistant") {
        conversationHistory.pop();
    }

    // Remove from UI (find and remove last assistant message)
    const messages = document.querySelectorAll(".message-assistant");
    if (messages.length > 0) {
        messages[messages.length - 1].remove();
    }

    // Regenerate
    await sendMessage(lastQuery);
}

// ============================================
// Exports
// ============================================

export function getConversationHistory() {
    return [...conversationHistory];
}

export function getCurrentMeetingId() {
    return currentMeetingId;
}

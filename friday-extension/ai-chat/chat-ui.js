// ai-chat/chat-ui.js
// DOM rendering, typewriter effect, scroll management

import { CONFIG } from "./config.js";

// ============================================
// DOM Elements
// ============================================

let chatContainer = null;
let inputField = null;
let sendButton = null;

/**
 * Initialize UI with DOM elements
 */
export function initUI(elements) {
    chatContainer = elements.chatContainer;
    inputField = elements.inputField;
    sendButton = elements.sendButton;
}

// ============================================
// Message Rendering
// ============================================

/**
 * Create a message element
 */
function createMessageElement(role, content, timestamp) {
    const wrapper = document.createElement("div");
    wrapper.className = `message message-${role}`;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.innerHTML = formatContent(content);

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(timestamp);

    wrapper.appendChild(bubble);
    wrapper.appendChild(time);

    return wrapper;
}

/**
 * Format message content (markdown-like)
 */
function formatContent(content) {
    return content
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`(.+?)`/g, "<code>$1</code>")
        .replace(/\n/g, "<br>");
}

/**
 * Format timestamp
 */
function formatTime(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    const today = new Date();
    const isToday = date.toDateString() === today.toDateString();

    const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (isToday) {
        return timeStr;
    }

    // Show date for older messages
    const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${dateStr}, ${timeStr}`;
}

/**
 * Append a message to the chat
 */
export function appendMessage(role, content, timestamp = new Date().toISOString()) {
    if (!chatContainer) return null;

    const element = createMessageElement(role, content, timestamp);
    chatContainer.appendChild(element);
    scrollToBottom();

    return element;
}

/**
 * Render multiple messages (batch)
 */
export function renderMessages(messages, prepend = false) {
    if (!chatContainer) return;

    const fragment = document.createDocumentFragment();

    for (const msg of messages) {
        const element = createMessageElement(msg.role, msg.content, msg.timestamp);
        fragment.appendChild(element);
    }

    if (prepend) {
        // Find where to insert - after load more button if it exists
        const loadMoreContainer = chatContainer.querySelector(".load-more-container");
        if (loadMoreContainer && loadMoreContainer.nextSibling) {
            chatContainer.insertBefore(fragment, loadMoreContainer.nextSibling);
        } else if (loadMoreContainer) {
            chatContainer.appendChild(fragment);
        } else if (chatContainer.firstChild) {
            chatContainer.insertBefore(fragment, chatContainer.firstChild);
        } else {
            chatContainer.appendChild(fragment);
        }
    } else {
        chatContainer.appendChild(fragment);
    }
}

/**
 * Render messages with instant positioning (WhatsApp-style)
 * Uses visibility trick to hide the scroll operation from the user
 */
export function renderMessagesInstant(messages) {
    if (!chatContainer || !messages.length) return;

    // 1. Hide container (preserves layout, just invisible)
    chatContainer.style.visibility = 'hidden';

    // 2. Render messages
    const fragment = document.createDocumentFragment();
    for (const msg of messages) {
        const element = createMessageElement(msg.role, msg.content, msg.timestamp);
        fragment.appendChild(element);
    }
    chatContainer.appendChild(fragment);

    // 3. Position scroll at bottom (instant, no animation)
    chatContainer.scrollTop = chatContainer.scrollHeight;

    // 4. Show container (user sees final state, no scroll visible)
    // Use requestAnimationFrame to ensure render is complete
    requestAnimationFrame(() => {
        chatContainer.style.visibility = 'visible';
    });
}

/**
 * Clear all messages
 */
export function clearMessages() {
    if (chatContainer) {
        chatContainer.innerHTML = "";
    }
    // Reset load more button reference since innerHTML cleared it
    loadMoreBtn = null;
}

// ============================================
// Load More Button
// ============================================

let loadMoreBtn = null;

/**
 * Show or hide load more button
 */
export function setLoadMoreVisible(visible) {
    if (!chatContainer) return;

    if (visible && !loadMoreBtn) {
        // Create load more button
        loadMoreBtn = document.createElement("div");
        loadMoreBtn.className = "load-more-container";
        loadMoreBtn.innerHTML = `
            <button class="load-more-btn">
                <span class="load-more-text">Load older messages</span>
                <span class="load-more-spinner hidden">
                    <svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                </span>
            </button>
        `;
        chatContainer.insertBefore(loadMoreBtn, chatContainer.firstChild);
    } else if (!visible && loadMoreBtn) {
        loadMoreBtn.remove();
        loadMoreBtn = null;
    }
}

/**
 * Set load more button loading state
 */
export function setLoadMoreLoading(loading) {
    if (!loadMoreBtn) return;

    const text = loadMoreBtn.querySelector(".load-more-text");
    const spinner = loadMoreBtn.querySelector(".load-more-spinner");
    const btn = loadMoreBtn.querySelector("button");

    if (loading) {
        if (text) text.classList.add("hidden");
        if (spinner) spinner.classList.remove("hidden");
        if (btn) btn.disabled = true;
    } else {
        if (text) text.classList.remove("hidden");
        if (spinner) spinner.classList.add("hidden");
        if (btn) btn.disabled = false;
    }
}

/**
 * Get load more button element (for adding click listener)
 */
export function getLoadMoreButton() {
    return loadMoreBtn?.querySelector("button");
}

// ============================================
// Typewriter Effect
// ============================================

/**
 * Create a typewriter for streaming responses
 */
export function createTypewriter(targetElement, options = {}) {
    const { cps = 60, onComplete } = options; // Characters per second

    let buffer = "";
    let displayedLength = 0;
    let rafId = null;
    let lastTime = 0;
    let isFinished = false;
    const msPerChar = 1000 / cps;

    function tick(timestamp) {
        if (!lastTime) lastTime = timestamp;
        const elapsed = timestamp - lastTime;

        // Type multiple characters per frame based on elapsed time
        const charsToAdd = Math.floor(elapsed / msPerChar);

        if (charsToAdd > 0 && displayedLength < buffer.length) {
            displayedLength = Math.min(displayedLength + charsToAdd, buffer.length);
            targetElement.innerHTML = formatContent(buffer.slice(0, displayedLength));
            lastTime = timestamp;

            // Auto-scroll as text appears
            scrollToBottom(false);
        }

        if (displayedLength < buffer.length) {
            rafId = requestAnimationFrame(tick);
        } else {
            // Typing complete
            rafId = null;
            scrollToBottom(true);
            if (isFinished && onComplete) {
                onComplete();
            }
        }
    }

    return {
        /**
         * Add text to the buffer
         */
        write(text) {
            buffer += text;
            if (!rafId) {
                rafId = requestAnimationFrame(tick);
            }
        },

        /**
         * Signal stream is done - typewriter continues until caught up
         */
        finish() {
            isFinished = true;
            // If already caught up, finalize
            if (!rafId && displayedLength >= buffer.length) {
                displayedLength = buffer.length;
                targetElement.innerHTML = formatContent(buffer);
                scrollToBottom(true);
                if (onComplete) onComplete();
            }
            // Otherwise let tick() finish naturally
        },

        /**
         * Get current buffer content
         */
        getContent() {
            return buffer;
        },
    };
}

// ============================================
// Scroll Management
// ============================================

let scrollThrottled = false;

/**
 * Scroll chat to bottom
 * @param {boolean} smooth - If true, animate scroll. If false, jump instantly (WhatsApp-style)
 */
export function scrollToBottom(smooth = true) {
    if (!chatContainer || scrollThrottled) return;

    if (smooth) {
        // Smooth scroll animation for new messages
        scrollThrottled = true;
        requestAnimationFrame(() => {
            chatContainer.scrollTo({
                top: chatContainer.scrollHeight,
                behavior: CONFIG.UI.scrollBehavior,
            });
            scrollThrottled = false;
        });
    } else {
        // Instant scroll - no animation (WhatsApp/Messenger style)
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
}

// ============================================
// Loading States
// ============================================

let loadingElement = null;

/**
 * Show loading indicator
 */
export function showLoading(message = "Thinking...") {
    hideLoading();

    loadingElement = document.createElement("div");
    loadingElement.className = "message message-assistant loading";
    loadingElement.innerHTML = `
    <div class="loading-dots">
      <span></span><span></span><span></span>
    </div>
    <span class="loading-text">${message}</span>
  `;

    if (chatContainer) {
        chatContainer.appendChild(loadingElement);
        scrollToBottom();
    }

    return loadingElement;
}

/**
 * Hide loading indicator
 */
export function hideLoading() {
    if (loadingElement) {
        loadingElement.remove();
        loadingElement = null;
    }
}

/**
 * Update loading message
 */
export function updateLoadingMessage(message) {
    if (loadingElement) {
        const textEl = loadingElement.querySelector(".loading-text");
        if (textEl) textEl.textContent = message;
    }
}

// ============================================
// Input Management
// ============================================

/**
 * Disable input during processing
 */
export function setInputDisabled(disabled) {
    if (inputField) inputField.disabled = disabled;
    if (sendButton) sendButton.disabled = disabled;
}

/**
 * Clear input field
 */
export function clearInput() {
    if (inputField) inputField.value = "";
}

/**
 * Focus input field
 */
export function focusInput() {
    if (inputField) inputField.focus();
}

// ============================================
// Error Display
// ============================================

/**
 * Show error message
 */
export function showError(message, retryCallback = null) {
    const errorEl = document.createElement("div");
    errorEl.className = "message message-error";
    errorEl.innerHTML = `
    <span class="error-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-red-500"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </span>
    <span class="error-text">${message}</span>
    ${retryCallback ? '<button class="retry-btn">Retry</button>' : ""}
  `;

    if (retryCallback) {
        errorEl.querySelector(".retry-btn").onclick = retryCallback;
    }

    if (chatContainer) {
        chatContainer.appendChild(errorEl);
        scrollToBottom();
    }

    return errorEl;
}

// ============================================
// Welcome State
// ============================================

/**
 * Show welcome message
 */
export function showWelcome() {
    clearMessages();

    const welcome = document.createElement("div");
    welcome.className = "welcome-message";
    welcome.innerHTML = `
    <div class="welcome-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="url(#welcomeGradient)" stroke-width="0" stroke-linecap="round" stroke-linejoin="round" width="80" height="80">
          <defs>
             <linearGradient id="welcomeGradient" x1="0%" y1="0%" x2="100%" y2="100%">
               <stop offset="0%" style="stop-color:#8b5cf6" />
               <stop offset="100%" style="stop-color:#6366f1" />
             </linearGradient>
          </defs>
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke-width="1.5"></path>
          <polyline points="22 4 12 14.01 9 11.01" stroke-width="1.5"></polyline>
        </svg>
    </div>
    <h3>Friday</h3>
    <p>Ask me anything about your meeting files and documents.</p>
  `;

    if (chatContainer) {
        chatContainer.appendChild(welcome);
    }
}

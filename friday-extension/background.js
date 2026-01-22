// background.js
let transcriptionState = {
  isTranscribing: false,
  selectedMeeting: null,
  userUid: null,
  meetTabId: null,
  transcriptDocId: null, // Store the document ID for the current session
};

// Check for API availability (prevents errors if run in wrong context)
if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "LOGIN_SUCCESS") {
      chrome.storage.local.set({
        email: message.email,
        uid: message.uid,
      });
      console.log("Stored user:", message.email);
    }

    // Handle transcription control messages
    if (message.type === "START_TRANSCRIPTION") {
      startBackgroundTranscription(message.meeting, message.uid)
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true; // Keep message channel open for async response
    }

    if (message.type === "STOP_TRANSCRIPTION") {
      stopBackgroundTranscription()
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }

    if (message.type === "GET_TRANSCRIPTION_STATUS") {
      sendResponse({ isTranscribing: transcriptionState.isTranscribing });
    }

    // Handle new transcript document messages
    if (message.type === "INITIALIZE_TRANSCRIPT") {
      initializeTranscriptDocument(
        message.uid,
        message.meetingId,
        message.startTime
      );
    }

    if (message.type === "UPDATE_TRANSCRIPT_REALTIME") {
      updateTranscriptRealtime(
        message.uid,
        message.meetingId,
        message.transcript,
        message.lastUpdated
      );
    }

    if (message.type === "FINALIZE_TRANSCRIPT") {
      finalizeTranscriptDocument(
        message.uid,
        message.meetingId,
        message.transcript,
        message.endTime,
        message.wordCount
      );
    }

    // Handle legacy messages for backward compatibility
    if (message.type === "TRANSCRIPTION_RESULT") {
      // Legacy handler - can be removed if not needed
      console.log("Legacy transcription result received");
    }

    if (message.type === "TRANSCRIPTION_ERROR") {
      broadcastTranscriptionError(message.error);
      stopBackgroundTranscription();
    }

    if (message.type === "CONTENT_SCRIPT_READY") {
      sendResponse({ success: true });
    }

    // Handle connection from extension pages
    if (message.type === "EXTENSION_PAGE_CONNECTED") {
      sendResponse({ success: true });
    }
  });
} else {
  console.error("FRIDAY EXTENSION ERROR: chrome.runtime.onMessage is undefined. Context invalid?");
}

async function startBackgroundTranscription(meeting, uid) {
  if (transcriptionState.isTranscribing) {
    console.log("Transcription already running");
    return;
  }

  transcriptionState.selectedMeeting = meeting;
  transcriptionState.userUid = uid;
  transcriptionState.transcriptDocId = null; // Reset document ID

  try {
    // Find Google Meet tab
    const tabs = await chrome.tabs.query({ url: "*://meet.google.com/*" });

    if (!tabs.length) {
      throw new Error("Please open the Google Meet meeting in a tab.");
    }

    transcriptionState.meetTabId = tabs[0].id;

    // Get Deepgram API key from storage (if configured)
    const storage = await chrome.storage.local.get(['deepgramApiKey']);
    const deepgramApiKey = storage.deepgramApiKey || null;

    // Inject content script to handle speech recognition (V3 with Deepgram support)
    await chrome.scripting.executeScript({
      target: { tabId: transcriptionState.meetTabId },
      files: ["transcription-content-v3.js"],
    });

    // Wait for content script to signal it's ready (handshake)
    await waitForContentScriptReady(transcriptionState.meetTabId, 5000);

    // Start transcription in content script
    await chrome.tabs.sendMessage(transcriptionState.meetTabId, {
      type: "START_TRANSCRIPTION",
      meetingId: meeting.meetingId,
      uid: uid,
      deepgramApiKey: deepgramApiKey, // Pass Deepgram key if available
    });

    transcriptionState.isTranscribing = true;
    broadcastTranscriptionStatus("started");

    console.log(`Transcription started ${deepgramApiKey ? '(Deepgram)' : '(Web Speech API)'}`);
  } catch (error) {
    console.error("Failed to start transcription:", error);
    throw error;
  }
}

/**
 * Waits for a CONTENT_SCRIPT_READY message from a specific tab.
 * This replaces the arbitrary setTimeout with a proper handshake.
 * @param {number} tabId - The tab ID to listen for
 * @param {number} timeoutMs - Max time to wait before giving up
 */
function waitForContentScriptReady(tabId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("Content script did not respond in time"));
    }, timeoutMs);

    function listener(message, sender) {
      if (
        message.type === "CONTENT_SCRIPT_READY" &&
        sender.tab &&
        sender.tab.id === tabId
      ) {
        clearTimeout(timeoutId);
        chrome.runtime.onMessage.removeListener(listener);
        console.log("Content script ready (handshake complete)");
        resolve();
      }
    }

    chrome.runtime.onMessage.addListener(listener);
  });
}

async function stopBackgroundTranscription() {
  if (!transcriptionState.isTranscribing) {
    return;
  }

  try {
    // Stop transcription in content script
    if (transcriptionState.meetTabId) {
      await chrome.tabs
        .sendMessage(transcriptionState.meetTabId, {
          type: "STOP_TRANSCRIPTION",
        })
        .catch(() => {
          // Ignore errors if tab is closed or content script not available
        });
    }
  } catch (error) {
    console.warn("Error stopping transcription:", error);
  }

  transcriptionState.isTranscribing = false;
  transcriptionState.meetTabId = null;
  // ✅ DON'T reset transcriptDocId here - let it persist for finalization

  broadcastTranscriptionStatus("stopped");
}

async function initializeTranscriptDocument(uid, meetingId, startTime) {
  try {
    // Only generate a new session ID if we don't already have one
    if (!transcriptionState.transcriptDocId) {
      const sessionId = `transcript_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      transcriptionState.transcriptDocId = sessionId;
    }

    // Send initialization request to extension pages
    const initData = {
      type: "INIT_TRANSCRIPT_DOC",
      uid: uid,
      meetingId: meetingId,
      docId: transcriptionState.transcriptDocId,
      startTime: startTime,
      status: "recording",
    };

    chrome.runtime.sendMessage(initData).catch(() => {
      // If no extension pages are available, store in chrome.storage as backup
      storeTranscriptInStorage(
        uid,
        meetingId,
        transcriptionState.transcriptDocId,
        {
          transcript: "",
          startTime: startTime,
          status: "recording",
          lastUpdated: startTime,
        }
      );
    });

    console.log(
      "Initialized transcript document:",
      transcriptionState.transcriptDocId
    );
  } catch (error) {
    console.error("Error initializing transcript document:", error);
  }
}

async function updateTranscriptRealtime(
  uid,
  meetingId,
  transcript,
  lastUpdated
) {
  // If no document ID yet (race condition), generate one immediately
  if (!transcriptionState.transcriptDocId) {
    console.log("No transcript document ID available, creating one now...");
    const sessionId = `transcript_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    transcriptionState.transcriptDocId = sessionId;

    // Initialize the document first
    await initializeTranscriptDocument(
      uid,
      meetingId,
      new Date().toISOString()
    );
  }

  try {
    // Send update request to extension pages
    const updateData = {
      type: "UPDATE_TRANSCRIPT_DOC",
      uid: uid,
      meetingId: meetingId,
      docId: transcriptionState.transcriptDocId,
      transcript: transcript,
      lastUpdated: lastUpdated,
      status: "recording",
    };

    chrome.runtime.sendMessage(updateData).catch(() => {
      // If no extension pages are available, store in chrome.storage as backup
      storeTranscriptInStorage(
        uid,
        meetingId,
        transcriptionState.transcriptDocId,
        {
          transcript: transcript,
          lastUpdated: lastUpdated,
          status: "recording",
        }
      );
    });

    console.log(
      "Updated transcript document with",
      transcript.length,
      "characters"
    );
  } catch (error) {
    console.error("Error updating transcript document:", error);
  }
}

async function finalizeTranscriptDocument(
  uid,
  meetingId,
  transcript,
  endTime,
  wordCount
) {
  // If no document ID yet (edge case), generate one and initialize
  if (!transcriptionState.transcriptDocId) {
    console.log(
      "No transcript document ID available for finalization, creating one now..."
    );
    const sessionId = `transcript_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    transcriptionState.transcriptDocId = sessionId;

    // Initialize the document first
    await initializeTranscriptDocument(
      uid,
      meetingId,
      new Date().toISOString()
    );
  }

  try {
    // Send finalization request to extension pages
    const finalData = {
      type: "FINALIZE_TRANSCRIPT_DOC",
      uid: uid,
      meetingId: meetingId,
      docId: transcriptionState.transcriptDocId,
      transcript: transcript,
      endTime: endTime,
      wordCount: wordCount,
      status: "completed",
    };

    chrome.runtime.sendMessage(finalData).catch(() => {
      // If no extension pages are available, store in chrome.storage as backup
      storeTranscriptInStorage(
        uid,
        meetingId,
        transcriptionState.transcriptDocId,
        {
          transcript: transcript,
          endTime: endTime,
          wordCount: wordCount,
          status: "completed",
        }
      );
    });

    console.log(
      "Finalized transcript document:",
      transcriptionState.transcriptDocId
    );

    // ✅ NOW reset the transcriptDocId after successful finalization
    transcriptionState.transcriptDocId = null;
  } catch (error) {
    console.error("Error finalizing transcript document:", error);
  }
}

async function storeTranscriptInStorage(uid, meetingId, docId, data) {
  try {
    const storageKey = `transcript_${uid}_${meetingId}_${docId}`;
    await chrome.storage.local.set({
      [storageKey]: data,
    });
    console.log("Transcript stored in chrome.storage as backup:", storageKey);
  } catch (error) {
    console.error("Failed to store transcript in storage:", error);
  }
}

function broadcastTranscriptionStatus(status) {
  // Broadcast to all extension pages
  chrome.runtime
    .sendMessage({
      type: "TRANSCRIPTION_STATUS_UPDATE",
      status: status,
      isTranscribing: transcriptionState.isTranscribing,
    })
    .catch(() => {
      // Ignore errors if no listeners
    });
}

function broadcastTranscriptionError(error) {
  transcriptionState.isTranscribing = false;
  chrome.runtime
    .sendMessage({
      type: "TRANSCRIPTION_ERROR",
      error: error,
    })
    .catch(() => {
      // Ignore errors if no listeners
    });
}

// Handle tab close/navigation
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === transcriptionState.meetTabId) {
    stopBackgroundTranscription();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    tabId === transcriptionState.meetTabId &&
    changeInfo.url &&
    !changeInfo.url.includes("meet.google.com")
  ) {
    stopBackgroundTranscription();
  }
});

// ========================================
// SIDE PANEL BEHAVIOR
// ========================================

// Function to configure side panel behavior based on login state
async function configureSidePanelBehavior() {
  // Check if sidePanel API is available
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;

  try {
    const { uid } = await chrome.storage.local.get("uid");

    if (uid) {
      // If logged in, clicking icon opens popup (user request)
      // The side panel will only open when explicitly requested via "Ask AI" button
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      console.log("Side Panel behavior: Disabled (Popup will open)");
    } else {
      // If not logged in, clicking icon opens popup (default)
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      console.log("Side Panel behavior: Disabled (Show popup for login)");
    }
  } catch (error) {
    console.error("Error configuring side panel behavior:", error);
  }
}

// Check on startup
chrome.runtime.onStartup.addListener(configureSidePanelBehavior);
chrome.runtime.onInstalled.addListener(configureSidePanelBehavior);

// Check when storage changes (login/logout)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.uid) {
    configureSidePanelBehavior();
  }
});

// Also open side panel on install/update for convenience if logged in
chrome.runtime.onInstalled.addListener(async (details) => {
  // Don't auto-open, just configure
  configureSidePanelBehavior();
});

// Note: Module preloading is not possible in Service Workers (import() is disallowed).
// The lazy loading in chat.js handles performance optimization instead.


// Context Menu to Open Side Panel
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "openSidePanel",
    title: "Open Side Panel Chat",
    contexts: ["all"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "openSidePanel") {
    // Open side panel
    if (chrome.sidePanel && chrome.sidePanel.open && tab.windowId) {
      chrome.sidePanel.open({ windowId: tab.windowId });
    }
  }
});

// Listener for messages from popup/dashboard
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CLOSE_SIDE_PANEL") {
    if (chrome.sidePanel && chrome.sidePanel.setOptions) {
      // Disable panel at window level
      chrome.sidePanel.setOptions({
        enabled: false
      }).catch(e => console.log("Background: Side panel close failed", e));
    }
    // Respond immediately so sender doesn't wait
    sendResponse({ success: true });
  }
});

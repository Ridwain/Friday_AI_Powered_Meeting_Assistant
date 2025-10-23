// background.js
let transcriptionState = {
  isTranscribing: false,
  selectedMeeting: null,
  userUid: null,
  meetTabId: null,
  transcriptDocId: null, // Store the document ID for the current session
};

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

    // Inject content script to handle speech recognition
    await chrome.scripting.executeScript({
      target: { tabId: transcriptionState.meetTabId },
      files: ["transcription-content.js"],
    });

    // Wait a bit for content script to load
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Start transcription in content script
    await chrome.tabs.sendMessage(transcriptionState.meetTabId, {
      type: "START_TRANSCRIPTION",
      meetingId: meeting.meetingId,
      uid: uid,
    });

    transcriptionState.isTranscribing = true;
    broadcastTranscriptionStatus("started");
  } catch (error) {
    console.error("Failed to start transcription:", error);
    throw error;
  }
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

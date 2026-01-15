//dashboard.js
import { auth, db } from "./firebase-config.js";
import { signOut } from "./firebase/firebase-auth.js";
import {
  collection,
  getDocs,
  addDoc,
  setDoc,
  doc,
  serverTimestamp,
  updateDoc,
} from "./firebase/firebase-firestore.js";

const welcome = document.getElementById("welcome");
const meetingsDiv = document.getElementById("meetings");
const logoutBtn = document.getElementById("logoutBtn");
const transcriptionBtn = document.getElementById("transcriptionBtn");

// Real‑time transcript embedding and upsert helpers
const REALTIME_PINECONE_URL = "http://localhost:3000/upsert";

// NEW SECURE VERSION:
const SERVER_URL = "http://localhost:3000";

async function generateRealtimeEmbedding(text) {
  try {
    if (!text || text.trim().length < 10) {
      console.log("Text too short for embedding, skipping");
      return null;
    }

    const input = text.length > 8000 ? text.slice(-8000) : text;
    console.log(
      `Generating embedding for text: "${input.substring(0, 100)}..."`
    );

    const response = await fetch(`${SERVER_URL}/ai/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Server embedding error: ${response.status} - ${errorData.error || "Unknown error"
        }`
      );
    }

    const data = await response.json();
    console.log("Successfully generated embedding");
    return data.embedding;
  } catch (err) {
    console.error("generateRealtimeEmbedding error:", err);
    return null;
  }
}

// Improved function to upsert transcript to Pinecone
// Improved function to upsert transcript to Pinecone with a unique ID
async function upsertRealtimeTranscript(meetingId, transcript) {
  try {
    if (!transcript || transcript.trim().length < 20) {
      console.log("⏭️ Transcript too short for Pinecone upload, skipping");
      return;
    }

    console.log(`🚀 Starting Pinecone upload for meeting ${meetingId}`);
    console.log(`📝 Transcript length: ${transcript.length} characters`);

    const embedding = await generateRealtimeEmbedding(transcript);
    if (!embedding) {
      console.error(
        "❌ Failed to generate embedding, skipping Pinecone upload"
      );
      return;
    }

    // Create a unique ID based on meetingId and current timestamp
    const uniqueId = `${meetingId}_realtime_${Date.now()}`;

    const vector = {
      id: uniqueId, // Ensure unique ID here
      values: embedding,
      metadata: {
        meetingId: meetingId,
        content: transcript.slice(-1000), // Last 1000 characters for metadata
        type: "meeting_transcript",
        updatedAt: new Date().toISOString(),
        wordCount: transcript.trim().split(/\s+/).length,
      },
    };

    console.log(`📤 Uploading to Pinecone namespace: ${meetingId}`);

    const response = await fetch(REALTIME_PINECONE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        namespace: meetingId,
        vectors: [vector],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Pinecone upsert failed: ${response.status} - ${errorText}`
      );
    }

    const result = await response.json();
    console.log(
      `✅ Successfully uploaded transcript to Pinecone namespace: ${meetingId}`
    );
    console.log(`📊 Upserted count: ${result.upsertedCount || 1}`);
  } catch (err) {
    console.error("❌ upsertRealtimeTranscript error:", err);
  }
}

let selectedMeeting = null;
let isTranscribing = false;
let cachedMeetings = []; // Store fetched meetings here
let currentUid = null;
let isInDetailView = false; // Track if user is viewing meeting details

// Note: Bottom buttons visibility is now controlled via CSS (.visible class)

// Notify background script that extension page is available
chrome.runtime.sendMessage({ type: "EXTENSION_PAGE_CONNECTED" });

// Listen for transcription status updates from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRANSCRIPTION_STATUS_UPDATE") {
    isTranscribing = message.isTranscribing;
    updateTranscriptionButton();
  } else if (message.type === "TRANSCRIPTION_ERROR") {
    isTranscribing = false;
    updateTranscriptionButton();
    alert("Transcription error: " + message.error);
  }
  // Handle new single-document transcript operations
  else if (message.type === "INIT_TRANSCRIPT_DOC") {
    initializeTranscriptDocument(
      message.uid,
      message.meetingId,
      message.docId,
      message.startTime,
      message.status
    );
    sendResponse({ success: true });
  } else if (message.type === "UPDATE_TRANSCRIPT_DOC") {
    updateTranscriptDocument(
      message.uid,
      message.meetingId,
      message.docId,
      message.transcript,
      message.lastUpdated,
      message.status
    );
    sendResponse({ success: true });
  } else if (message.type === "FINALIZE_TRANSCRIPT_DOC") {
    finalizeTranscriptDocument(
      message.uid,
      message.meetingId,
      message.docId,
      message.transcript,
      message.endTime,
      message.wordCount,
      message.status
    );
    sendResponse({ success: true });
  }
  // Handle legacy transcript operations for backward compatibility
  else if (message.type === "SAVE_TRANSCRIPT_REQUEST") {
    // Handle transcript saving request from background script (legacy)
    saveTranscriptToFirebase(
      message.uid,
      message.meetingId,
      message.transcript
    );
    sendResponse({ success: true });
  } else if (message.type === "PROCESS_TRANSCRIPT_QUEUE") {
    // Process queued transcripts (legacy)
    processQueuedTranscripts(message.queue);
    sendResponse({ success: true });
  }
});

// Function to initialize a new transcript document
async function initializeTranscriptDocument(
  uid,
  meetingId,
  docId,
  startTime,
  status
) {
  try {
    const transcriptDocRef = doc(
      db,
      "users",
      uid,
      "meetings",
      meetingId,
      "transcripts",
      docId
    );
    await setDoc(transcriptDocRef, {
      transcript: "",
      startTime: startTime,
      lastUpdated: startTime,
      status: status,
      wordCount: 0,
      createdAt: serverTimestamp(),
    });
    console.log(`Initialized transcript document: ${docId}`);
  } catch (error) {
    console.error("Error initializing transcript document:", error);
    // Fallback to chrome.storage
    await storeTranscriptInStorage(uid, meetingId, docId, {
      transcript: "",
      startTime: startTime,
      status: status,
    });
  }
}

// FIXED: Function to update transcript document in real-time with Pinecone upload
async function updateTranscriptDocument(
  uid,
  meetingId,
  docId,
  transcript,
  lastUpdated,
  status
) {
  try {
    const transcriptDocRef = doc(
      db,
      "users",
      uid,
      "meetings",
      meetingId,
      "transcripts",
      docId
    );

    // Use setDoc with merge: true to ensure document exists
    await setDoc(
      transcriptDocRef,
      {
        transcript: transcript,
        lastUpdated: lastUpdated,
        status: status,
        wordCount: transcript
          .trim()
          .split(/\s+/)
          .filter((word) => word.length > 0).length,
      },
      { merge: true }
    );

    console.log(
      `Updated transcript document: ${docId} (${transcript.length} chars)`
    );

    // 🔥 FIXED: Now properly upload to Pinecone with better error handling
    console.log(`🔄 Attempting Pinecone upload for meeting: ${meetingId}`);
    await upsertRealtimeTranscript(meetingId, transcript);
  } catch (error) {
    console.error("Error updating transcript document:", error);
    // Fallback to chrome.storage
    await storeTranscriptInStorage(uid, meetingId, docId, {
      transcript: transcript,
      lastUpdated: lastUpdated,
      status: status,
    });
  }
}

// Function to finalize transcript document with final Pinecone upload
async function finalizeTranscriptDocument(
  uid,
  meetingId,
  docId,
  transcript,
  endTime,
  wordCount,
  status
) {
  try {
    const transcriptDocRef = doc(
      db,
      "users",
      uid,
      "meetings",
      meetingId,
      "transcripts",
      docId
    );

    // Use setDoc with merge: true instead of updateDoc to ensure document exists
    await setDoc(
      transcriptDocRef,
      {
        transcript: transcript,
        endTime: endTime,
        status: status,
        wordCount: wordCount,
        finalizedAt: serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`Finalized transcript document: ${docId} (${wordCount} words)`);

    // 🔥 FIXED: Final upload to Pinecone with complete transcript
    console.log(`🏁 Final Pinecone upload for meeting: ${meetingId}`);
    await upsertRealtimeTranscript(meetingId, transcript);
  } catch (error) {
    console.error("Error finalizing transcript document:", error);
    // Fallback to chrome.storage
    await storeTranscriptInStorage(uid, meetingId, docId, {
      transcript: transcript,
      endTime: endTime,
      status: status,
      wordCount: wordCount,
    });
  }
}

// Fallback storage function
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

// Legacy functions for backward compatibility
async function processQueuedTranscripts(queue) {
  for (const item of queue) {
    await saveTranscriptToFirebase(item.uid, item.meetingId, item.transcript);
  }
  console.log(`Processed ${queue.length} queued transcripts`);

  // Also check for any transcripts stored in chrome.storage
  await processStoredTranscripts();
}

async function processStoredTranscripts() {
  try {
    const allData = await chrome.storage.local.get();
    const transcriptKeys = Object.keys(allData).filter((key) =>
      key.startsWith("transcript_")
    );

    for (const key of transcriptKeys) {
      const parts = key.split("_");
      if (parts.length >= 4) {
        // New format: transcript_uid_meetingId_docId
        const [, uid, meetingId, docId] = parts;
        const data = allData[key];

        if (data && typeof data === "object") {
          const transcriptDocRef = doc(
            db,
            "users",
            uid,
            "meetings",
            meetingId,
            "transcripts",
            docId
          );
          await setDoc(transcriptDocRef, {
            transcript: data.transcript || "",
            startTime: data.startTime,
            endTime: data.endTime,
            lastUpdated: data.lastUpdated,
            status: data.status || "completed",
            wordCount: data.wordCount || 0,
            createdAt: serverTimestamp(),
          });

          // Remove from storage after successful save
          await chrome.storage.local.remove(key);
          console.log(`Processed stored transcript: ${docId}`);
        }
      } else if (parts.length === 3) {
        // Legacy format: transcript_uid_meetingId
        const [, uid, meetingId] = parts;
        const transcript = allData[key];

        if (transcript && transcript.trim()) {
          const transcriptDocRef = doc(
            collection(db, "users", uid, "meetings", meetingId, "transcripts")
          );
          await setDoc(transcriptDocRef, {
            content: transcript,
            timestamp: serverTimestamp(),
          });

          // Remove from storage after successful save
          await chrome.storage.local.remove(key);
          console.log(
            `Processed legacy stored transcript for meeting ${meetingId}`
          );
        }
      }
    }
  } catch (error) {
    console.error("Error processing stored transcripts:", error);
  }
}

async function saveTranscriptToFirebase(uid, meetingId, transcript) {
  try {
    const transcriptDocRef = doc(
      collection(db, "users", uid, "meetings", meetingId, "transcripts")
    );
    await setDoc(
      transcriptDocRef,
      {
        content: transcript,
        timestamp: serverTimestamp(),
      },
      { merge: true }
    );
    console.log("Transcript saved successfully");
  } catch (err) {
    console.error("Failed to save transcript:", err);
  }
}

chrome.storage.local.get(
  ["email", "uid", "selectedMeetingForChat"],
  async (result) => {
    if (!result.email || !result.uid) {
      welcome.innerText = "Not logged in.";
      return;
    }

    currentUid = result.uid;
    welcome.innerText = `Welcome, ${result.email}`;
    selectedMeeting = result.selectedMeetingForChat || null;

    if (selectedMeeting) {
      showMeetingDetails(selectedMeeting);
      // Check current transcription status
      chrome.runtime.sendMessage(
        { type: "GET_TRANSCRIPTION_STATUS" },
        (response) => {
          if (response) {
            isTranscribing = response.isTranscribing;
            updateTranscriptionButton();
          }
        }
      );
    } else {
      loadMeetingList(result.uid);
    }
  }
);

function loadMeetingList(uid) {
  const cacheKey = `meeting_cache_${uid}`;
  let networkFinished = false;

  // 1. Try to load from local cache first for instant UI
  chrome.storage.local.get([cacheKey], (result) => {
    if (networkFinished) return;
    if (result[cacheKey] && Array.isArray(result[cacheKey])) {
      console.log("Loaded meetings from local cache");
      cachedMeetings = result[cacheKey];
      renderMeetingList();
    }
  });

  // 2. Fetch fresh data from Firebase
  const meetingsRef = collection(db, "users", uid, "meetings");
  getDocs(meetingsRef).then((snapshot) => {
    networkFinished = true;
    const freshMeetings = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      data.meetingId = doc.id;
      freshMeetings.push(data);
    });

    // Update memory cache and local storage
    cachedMeetings = freshMeetings;
    chrome.storage.local.set({ [cacheKey]: freshMeetings });
    renderMeetingList();
  }).catch((error) => {
    console.error("Error loading meetings:", error);
  });
}

function renderMeetingList() {
  // Don't reset if user has navigated to detail view
  if (isInDetailView) {
    console.log("Skipping renderMeetingList - user is in detail view");
    return;
  }

  selectedMeeting = null;
  meetingsDiv.innerHTML = "";
  document.getElementById("bottomButtons").classList.remove("visible");

  // Show welcome section when viewing list
  const welcomeSection = document.querySelector('.welcome-section');
  if (welcomeSection) {
    welcomeSection.style.display = 'block';
  }
  welcome.style.display = "block"; // Ensure welcome message is visible

  // Show logout button when viewing meeting list
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.style.display = '';
  }

  // Update meeting count badge
  const countBadge = document.getElementById("meetingCount");
  if (countBadge) {
    countBadge.textContent = cachedMeetings.length;
  }

  // Show empty state if no meetings
  if (cachedMeetings.length === 0) {
    meetingsDiv.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"></div>
        <h3 class="empty-state-title">No meetings yet</h3>
        <p class="empty-state-description">Your scheduled meetings will appear here.</p>
      </div>
    `;
    return;
  }

  // Render meeting cards with staggered animation
  cachedMeetings.forEach((data, index) => {
    const div = document.createElement("div");
    div.className = "meeting-card";
    div.style.animationDelay = `${index * 50}ms`;

    // Determine meeting status
    const status = getMeetingStatus(data);
    const statusClass = status === 'Live' ? 'live' : status === 'Upcoming' ? 'upcoming' : 'past';

    // Truncate long links for display
    const displayLink = data.meetingLink ? truncateLink(data.meetingLink, 35) : 'No link';

    div.innerHTML = `
      <div class="meeting-card-header">
        <div class="meeting-datetime">
          <span class="meeting-date">${data.meetingDate}</span>
          <span class="meeting-time">${data.meetingTime}</span>
        </div>
        <span class="meeting-status ${statusClass}">${status}</span>
      </div>
      <div class="meeting-link">
        <span>${displayLink}</span>
      </div>
      <div class="meeting-cta">View details</div>
    `;
    div.onclick = () => showMeetingDetails(data);
    meetingsDiv.appendChild(div);
  });
}

// Helper: Get meeting status based on date/time
function getMeetingStatus(meeting) {
  try {
    const now = new Date();
    const meetingDate = new Date(`${meeting.meetingDate} ${meeting.meetingTime}`);
    const diffMs = meetingDate - now;
    const diffMins = diffMs / (1000 * 60);

    if (diffMins >= -60 && diffMins <= 30) {
      return 'Live';
    } else if (diffMins > 30) {
      return 'Upcoming';
    } else {
      return 'Past';
    }
  } catch {
    return 'Upcoming';
  }
}

// Helper: Truncate long links
function truncateLink(url, maxLength) {
  if (!url) return 'No link';
  if (url.length <= maxLength) return url;
  return url.substring(0, maxLength) + '...';
}

function showMeetingDetails(data) {
  isInDetailView = true; // Mark that we're in detail view
  selectedMeeting = data;

  // Hide welcome section when viewing details
  const welcomeSection = document.querySelector('.welcome-section');
  if (welcomeSection) {
    welcomeSection.style.display = 'none';
  }

  // Hide logout button when viewing meeting details
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.style.display = 'none';
  }

  // Get meeting status
  const status = getMeetingStatus(data);
  const statusClass = status === 'Live' ? 'live' : status === 'Upcoming' ? 'upcoming' : 'past';

  meetingsDiv.innerHTML = `
    <div class="meeting-details">
      <div class="meeting-details-header">
        <h2>Meeting Details</h2>
        <p>Review and manage this meeting</p>
      </div>
      
      <div class="detail-card">
        <h4 class="detail-card-title">Schedule</h4>
        <div class="detail-row">
          <span class="detail-label">Date</span>
          <span class="detail-value">${data.meetingDate}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Time</span>
          <span class="detail-value">${data.meetingTime}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Status</span>
          <span class="detail-value"><span class="meeting-status ${statusClass}">${status}</span></span>
        </div>
      </div>
      
      <div class="detail-card">
        <h4 class="detail-card-title">Resources</h4>
        <div class="detail-row">
          <span class="detail-label">Meeting</span>
          <span class="detail-value"><a href="${data.meetingLink}" target="_blank">Open Meeting Link</a></span>
        </div>
        ${data.driveFolderLink ? `
        <div class="detail-row">
          <span class="detail-label">Drive</span>
          <span class="detail-value"><a href="${data.driveFolderLink}" target="_blank">Open Drive Folder</a></span>
        </div>
        ` : ''}
      </div>
    </div>
  `;

  const bottomButtons = document.getElementById("bottomButtons");
  bottomButtons.classList.add("visible");

  document.getElementById("backBtn").onclick = () => {
    // Close Side Panel at window level
    chrome.runtime.sendMessage({ type: "CLOSE_SIDE_PANEL" });

    // Clear the detail view flag so renderMeetingList can work
    isInDetailView = false;

    chrome.storage.local.get("chatWindowId", ({ chatWindowId }) => {
      // Clear meeting AND activation flag
      chrome.storage.local.set({
        selectedMeetingForChat: null,
        chatSessionActive: false
      });

      const goBackToList = () => {
        if (cachedMeetings.length > 0) {
          renderMeetingList(); // Restore cached list instantly
        } else if (currentUid) {
          loadMeetingList(currentUid); // Fetch if cache missing (e.g. after reopen)
        } else {
          // Fallback reload if we lost state completely
          window.location.reload();
        }
      };

      if (chatWindowId) {
        chrome.windows.remove(chatWindowId, () => {
          chrome.storage.local.remove(["chatWindowId"], () => {
            goBackToList();
          });
        });
      } else {
        goBackToList();
      }
    });
  };

  document.getElementById("openChatBtn").onclick = () => {
    if (!selectedMeeting) {
      alert("Please select a meeting first.");
      return;
    }
    // Set flag explicitly when button is clicked
    // CRITICAL: We must call openOrFocusChatWindow() synchronously/immediately to preserve 
    // the user gesture. We run the storage update in parallel.
    chrome.storage.local.set({ chatSessionActive: true });
    openOrFocusChatWindow();
  };

  transcriptionBtn.onclick = () => {
    if (!selectedMeeting) {
      alert("Please select a meeting first.");
      return;
    }
    if (isTranscribing) {
      stopTranscription();
    } else {
      startTranscription();
    }
  };

  // Always set the meeting in storage when viewing details
  // This ensures chat.js can always find the selected meeting
  chrome.storage.local.set({ selectedMeetingForChat: data });
}

function updateTranscriptionButton() {
  if (isTranscribing) {
    transcriptionBtn.innerHTML = "Stop";
    transcriptionBtn.title = "Stop Transcription (Running in Background)";
    transcriptionBtn.classList.add("transcribing");
    transcriptionBtn.classList.remove("action-btn-secondary");
  } else {
    transcriptionBtn.innerHTML = "Transcribe";
    transcriptionBtn.title = "Start Transcription";
    transcriptionBtn.classList.remove("transcribing");
    transcriptionBtn.classList.add("action-btn-secondary");
  }
}

function openOrFocusChatWindow() {
  // Try to use the active tab in the current window
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];

    // Check if we can inject into this tab (must be http/https)
    if (activeTab && activeTab.url && (activeTab.url.startsWith("http://") || activeTab.url.startsWith("https://"))) {
      // Open Side Panel directly
      if (chrome.sidePanel && chrome.sidePanel.open) {
        // Enable panel at window level (persists across tabs)
        const enablePanel = async () => {
          try {
            if (chrome.sidePanel.setOptions) {
              await chrome.sidePanel.setOptions({
                enabled: true,
                path: 'chat.html'
              });
              // No need to store tabId - panel is window-level now
            }
          } catch (e) {
            console.warn("SidePanel setOptions failed (non-fatal):", e);
          }
        };

        enablePanel().then(() => {
          return chrome.sidePanel.open({ windowId: activeTab.windowId || chrome.windows.WINDOW_ID_CURRENT });
        }).catch(err => {
          console.error("Failed to open side panel:", err);
          alert("Unable to open Side Panel on this page. Please try navigating to a different website.");
        });
      } else {
        alert("Side Panel API not available.");
      }

    } else {
      // Current page is restricted (e.g. new tab, chrome://settings)
      console.log("Restricted page or no active tab");
      alert("Please navigate to a normal web page (http/https) to use the AI chat. Browser settings pages are restricted.");
    }
  });
}

function openPopupChatWindow() {
  chrome.storage.local.get("chatWindowId", ({ chatWindowId }) => {
    if (chatWindowId) {
      chrome.windows.get(chatWindowId, (win) => {
        if (chrome.runtime.lastError || !win) {
          launchChatWindow();
        } else {
          chrome.windows.update(chatWindowId, { focused: true });
        }
      });
    } else {
      launchChatWindow();
    }
  });
}

function launchChatWindow() {
  const chatWidth = 400;
  const chatHeight = 500;
  const screenWidth = screen.availWidth;
  const screenHeight = screen.availHeight;
  const left = screenWidth - chatWidth - 10;
  const top = screenHeight - chatHeight - 10;

  chrome.windows.create(
    {
      url: chrome.runtime.getURL("chat.html"),
      type: "popup",
      focused: true,
      width: chatWidth,
      height: chatHeight,
      left: left,
      top: top,
    },
    (win) => {
      if (!win || !win.id) return;
      chrome.windows.update(win.id, {
        width: chatWidth,
        height: chatHeight,
        left: left,
        top: top,
        focused: true,
      });
      chrome.storage.local.set({ chatWindowId: win.id });
    }
  );
}

function startTranscription() {
  if (
    !selectedMeeting ||
    !selectedMeeting.meetingLink.includes("meet.google.com")
  ) {
    alert("Transcription is only supported for Google Meet meetings.");
    return;
  }

  chrome.storage.local.get(["uid"], (result) => {
    if (!result.uid) {
      alert("User not logged in.");
      return;
    }

    // Send message to background script to start transcription
    chrome.runtime.sendMessage(
      {
        type: "START_TRANSCRIPTION",
        meeting: selectedMeeting,
        uid: result.uid,
      },
      (response) => {
        if (response && response.success) {
          isTranscribing = true;
          updateTranscriptionButton();
        } else {
          alert("Failed to start transcription");
        }
      }
    );
  });
}

function stopTranscription() {
  // Send message to background script to stop transcription
  chrome.runtime.sendMessage(
    {
      type: "STOP_TRANSCRIPTION",
    },
    (response) => {
      if (response && response.success) {
        isTranscribing = false;
        updateTranscriptionButton();
      }
    }
  );
}

logoutBtn.onclick = async () => {
  try {
    // Stop transcription if running
    if (isTranscribing) {
      stopTranscription();
    }

    await signOut(auth);
    chrome.storage.local.get("chatWindowId", ({ chatWindowId }) => {
      if (chatWindowId) {
        chrome.windows.remove(chatWindowId, () => {
          chrome.storage.local.remove(
            ["email", "uid", "selectedMeetingForChat", "chatWindowId"],
            () => {
              window.location.href = "popup.html";
            }
          );
        });
      } else {
        chrome.storage.local.remove(
          ["email", "uid", "selectedMeetingForChat", "chatWindowId"],
          () => {
            window.location.href = "popup.html";
          }
        );
      }
    });
  } catch (error) {
    alert("Logout error: " + error.message);
  }
};

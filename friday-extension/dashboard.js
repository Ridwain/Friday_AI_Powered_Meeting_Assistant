//dashboard.js
import { auth, db } from './firebase-config.js';
import { signOut } from './firebase/firebase-auth.js';
import { collection, getDocs, addDoc, setDoc, doc, serverTimestamp, updateDoc } from './firebase/firebase-firestore.js';

const welcome = document.getElementById("welcome");
const meetingsDiv = document.getElementById("meetings");
const logoutBtn = document.getElementById("logoutBtn");
const transcriptionBtn = document.getElementById("transcriptionBtn");

// Real‑time transcript embedding and upsert helpers
const REALTIME_PINECONE_URL = 'http://localhost:3000/upsert';
const GEMINI_KEY = '';

async function generateRealtimeEmbedding(text) {
  try {
    if (!text || text.trim().length < 10) {
      console.log('Text too short for embedding, skipping');
      return null;
    }

    const input = text.length > 8000 ? text.slice(-8000) : text;
    console.log(`Generating embedding for text: "${input.substring(0, 100)}..."`);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'text-embedding-004',
          content: {
            parts: [{ text: input }]
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('Successfully generated embedding');
    return data.embedding?.values;
  } catch (err) {
    console.error('generateRealtimeEmbedding error:', err);
    return null;
  }
}

// Improved function to upsert transcript to Pinecone
// Improved function to upsert transcript to Pinecone with a unique ID
async function upsertRealtimeTranscript(meetingId, transcript) {
  try {
    if (!transcript || transcript.trim().length < 20) {
      console.log('⏭️ Transcript too short for Pinecone upload, skipping');
      return;
    }

    console.log(`🚀 Starting Pinecone upload for meeting ${meetingId}`);
    console.log(`📝 Transcript length: ${transcript.length} characters`);

    const embedding = await generateRealtimeEmbedding(transcript);
    if (!embedding) {
      console.error('❌ Failed to generate embedding, skipping Pinecone upload');
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
        type: 'meeting_transcript',
        updatedAt: new Date().toISOString(),
        wordCount: transcript.trim().split(/\s+/).length
      }
    };

    console.log(`📤 Uploading to Pinecone namespace: ${meetingId}`);
    
    const response = await fetch(REALTIME_PINECONE_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        namespace: meetingId,
        vectors: [vector]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pinecone upsert failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`✅ Successfully uploaded transcript to Pinecone namespace: ${meetingId}`);
    console.log(`📊 Upserted count: ${result.upsertedCount || 1}`);

  } catch (err) {
    console.error('❌ upsertRealtimeTranscript error:', err);
  }
}


let selectedMeeting = null;
let isTranscribing = false;

document.getElementById('bottomButtons').style.display = 'none';

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
    initializeTranscriptDocument(message.uid, message.meetingId, message.docId, message.startTime, message.status);
    sendResponse({success: true});
  } else if (message.type === "UPDATE_TRANSCRIPT_DOC") {
    updateTranscriptDocument(message.uid, message.meetingId, message.docId, message.transcript, message.lastUpdated, message.status);
    sendResponse({success: true});
  } else if (message.type === "FINALIZE_TRANSCRIPT_DOC") {
    finalizeTranscriptDocument(message.uid, message.meetingId, message.docId, message.transcript, message.endTime, message.wordCount, message.status);
    sendResponse({success: true});
  }
  // Handle legacy transcript operations for backward compatibility
  else if (message.type === "SAVE_TRANSCRIPT_REQUEST") {
    // Handle transcript saving request from background script (legacy)
    saveTranscriptToFirebase(message.uid, message.meetingId, message.transcript);
    sendResponse({success: true});
  } else if (message.type === "PROCESS_TRANSCRIPT_QUEUE") {
    // Process queued transcripts (legacy)
    processQueuedTranscripts(message.queue);
    sendResponse({success: true});
  }
});

// Function to initialize a new transcript document
async function initializeTranscriptDocument(uid, meetingId, docId, startTime, status) {
  try {
    const transcriptDocRef = doc(db, "users", uid, "meetings", meetingId, "transcripts", docId);
    await setDoc(transcriptDocRef, {
      transcript: "",
      startTime: startTime,
      lastUpdated: startTime,
      status: status,
      wordCount: 0,
      createdAt: serverTimestamp()
    });
    console.log(`Initialized transcript document: ${docId}`);
  } catch (error) {
    console.error("Error initializing transcript document:", error);
    // Fallback to chrome.storage
    await storeTranscriptInStorage(uid, meetingId, docId, {
      transcript: "",
      startTime: startTime,
      status: status
    });
  }
}

// FIXED: Function to update transcript document in real-time with Pinecone upload
async function updateTranscriptDocument(uid, meetingId, docId, transcript, lastUpdated, status) {
  try {
    const transcriptDocRef = doc(db, "users", uid, "meetings", meetingId, "transcripts", docId);
    
    // Use setDoc with merge: true to ensure document exists
    await setDoc(transcriptDocRef, {
      transcript: transcript,
      lastUpdated: lastUpdated,
      status: status,
      wordCount: transcript.trim().split(/\s+/).filter(word => word.length > 0).length
    }, { merge: true });
    
    console.log(`Updated transcript document: ${docId} (${transcript.length} chars)`);
    
    // 🔥 FIXED: Now properly upload to Pinecone with better error handling
    console.log(`🔄 Attempting Pinecone upload for meeting: ${meetingId}`);
    await upsertRealtimeTranscript(meetingId, transcript);
    
  } catch (error) {
    console.error("Error updating transcript document:", error);
    // Fallback to chrome.storage
    await storeTranscriptInStorage(uid, meetingId, docId, {
      transcript: transcript,
      lastUpdated: lastUpdated,
      status: status
    });
  }
}

// Function to finalize transcript document with final Pinecone upload
async function finalizeTranscriptDocument(uid, meetingId, docId, transcript, endTime, wordCount, status) {
  try {
    const transcriptDocRef = doc(db, "users", uid, "meetings", meetingId, "transcripts", docId);
    
    // Use setDoc with merge: true instead of updateDoc to ensure document exists
    await setDoc(transcriptDocRef, {
      transcript: transcript,
      endTime: endTime,
      status: status,
      wordCount: wordCount,
      finalizedAt: serverTimestamp()
    }, { merge: true });
    
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
      wordCount: wordCount
    });
  }
}

// Fallback storage function
async function storeTranscriptInStorage(uid, meetingId, docId, data) {
  try {
    const storageKey = `transcript_${uid}_${meetingId}_${docId}`;
    await chrome.storage.local.set({
      [storageKey]: data
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
    const transcriptKeys = Object.keys(allData).filter(key => key.startsWith('transcript_'));
    
    for (const key of transcriptKeys) {
      const parts = key.split('_');
      if (parts.length >= 4) {
        // New format: transcript_uid_meetingId_docId
        const [, uid, meetingId, docId] = parts;
        const data = allData[key];
        
        if (data && typeof data === 'object') {
          const transcriptDocRef = doc(db, "users", uid, "meetings", meetingId, "transcripts", docId);
          await setDoc(transcriptDocRef, {
            transcript: data.transcript || "",
            startTime: data.startTime,
            endTime: data.endTime,
            lastUpdated: data.lastUpdated,
            status: data.status || 'completed',
            wordCount: data.wordCount || 0,
            createdAt: serverTimestamp()
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
          const transcriptDocRef = doc(collection(db, "users", uid, "meetings", meetingId, "transcripts"));
          await setDoc(transcriptDocRef, { 
            content: transcript, 
            timestamp: serverTimestamp() 
          });
          
          // Remove from storage after successful save
          await chrome.storage.local.remove(key);
          console.log(`Processed legacy stored transcript for meeting ${meetingId}`);
        }
      }
    }
  } catch (error) {
    console.error("Error processing stored transcripts:", error);
  }
}

async function saveTranscriptToFirebase(uid, meetingId, transcript) {
  try {
    const transcriptDocRef = doc(collection(db, "users", uid, "meetings", meetingId, "transcripts"));
    await setDoc(transcriptDocRef, { 
      content: transcript, 
      timestamp: serverTimestamp() 
    }, { merge: true });
    console.log("Transcript saved successfully");
  } catch (err) {
    console.error("Failed to save transcript:", err);
  }
}

chrome.storage.local.get(["email", "uid", "selectedMeetingForChat"], async (result) => {
  if (!result.email || !result.uid) {
    welcome.innerText = "Not logged in.";
    return;
  }

  welcome.innerText = `Welcome, ${result.email}`;
  selectedMeeting = result.selectedMeetingForChat || null;

  if (selectedMeeting) {
    showMeetingDetails(selectedMeeting);
    // Check current transcription status
    chrome.runtime.sendMessage({ type: "GET_TRANSCRIPTION_STATUS" }, (response) => {
      if (response) {
        isTranscribing = response.isTranscribing;
        updateTranscriptionButton();
      }
    });
  } else {
    loadMeetingList(result.uid);
  }
});

function loadMeetingList(uid) {
  const meetingsRef = collection(db, "users", uid, "meetings");
  getDocs(meetingsRef).then((snapshot) => {
    meetingsDiv.innerHTML = '';
    snapshot.forEach(doc => {
      const data = doc.data();
      data.meetingId = doc.id;
      const div = document.createElement("div");
      div.className = "meeting-card";
      div.innerHTML = `
        <strong>${data.meetingDate} @ ${data.meetingTime}</strong><br>
        <em>Click to view details</em>
      `;
      div.onclick = () => showMeetingDetails(data);
      meetingsDiv.appendChild(div);
    });
  });
}

function showMeetingDetails(data) {
  selectedMeeting = data;

  meetingsDiv.innerHTML = `
    <h3>Meeting Details</h3>
    <p><strong>Date:</strong> ${data.meetingDate}</p>
    <p><strong>Time:</strong> ${data.meetingTime}</p>
    <p><strong>Link:</strong> <a href="${data.meetingLink}" target="_blank">${data.meetingLink}</a></p>
    <p><strong>Drive:</strong> <a href="${data.driveFolderLink}" target="_blank">${data.driveFolderLink}</a></p>
  `;

  const bottomButtons = document.getElementById('bottomButtons');
  bottomButtons.style.display = 'flex';

  document.getElementById("backBtn").onclick = () => {
    chrome.storage.local.get("chatWindowId", ({ chatWindowId }) => {
      if (chatWindowId) {
        chrome.windows.remove(chatWindowId, () => {
          chrome.storage.local.remove(["selectedMeetingForChat", "chatWindowId"], () => {
            window.location.reload();
          });
        });
      } else {
        chrome.storage.local.remove(["selectedMeetingForChat", "chatWindowId"], () => {
          window.location.reload();
        });
      }
    });
  };

  document.getElementById("openChatBtn").onclick = () => {
    if (!selectedMeeting) {
      alert("Please select a meeting first.");
      return;
    }
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

  chrome.storage.local.set({ selectedMeetingForChat: data });
}

function updateTranscriptionButton() {
  if (isTranscribing) {
    transcriptionBtn.textContent = "🎙️ Stop Transcription";
    transcriptionBtn.title = "Stop Transcription (Running in Background)";
    transcriptionBtn.style.backgroundColor = "#d9534f"; // Red color when active
  } else {
    transcriptionBtn.textContent = "🎙️ Start Transcription";
    transcriptionBtn.title = "Start Transcription";
    transcriptionBtn.style.backgroundColor = "#222"; // Default color
  }
}

function openOrFocusChatWindow() {
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

  chrome.windows.create({
    url: chrome.runtime.getURL("chat.html"),
    type: "popup",
    focused: true,
    width: chatWidth,
    height: chatHeight,
    left: left,
    top: top
  }, (win) => {
    if (!win || !win.id) return;
    chrome.windows.update(win.id, {
      width: chatWidth,
      height: chatHeight,
      left: left,
      top: top,
      focused: true
    });
    chrome.storage.local.set({ chatWindowId: win.id });
  });
}

function startTranscription() {
  if (!selectedMeeting || !selectedMeeting.meetingLink.includes("meet.google.com")) {
    alert("Transcription is only supported for Google Meet meetings.");
    return;
  }

  chrome.storage.local.get(["uid"], (result) => {
    if (!result.uid) {
      alert("User not logged in.");
      return;
    }

    // Send message to background script to start transcription
    chrome.runtime.sendMessage({
      type: "START_TRANSCRIPTION",
      meeting: selectedMeeting,
      uid: result.uid
    }, (response) => {
      if (response && response.success) {
        isTranscribing = true;
        updateTranscriptionButton();
      } else {
        alert("Failed to start transcription");
      }
    });
  });
}

function stopTranscription() {
  // Send message to background script to stop transcription
  chrome.runtime.sendMessage({
    type: "STOP_TRANSCRIPTION"
  }, (response) => {
    if (response && response.success) {
      isTranscribing = false;
      updateTranscriptionButton();
    }
  });
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
          chrome.storage.local.remove([
            "email",
            "uid",
            "selectedMeetingForChat",
            "chatWindowId"
          ], () => {
            window.location.href = "popup.html";
          });
        });
      } else {
        chrome.storage.local.remove([
          "email",
          "uid",
          "selectedMeetingForChat",
          "chatWindowId"
        ], () => {
          window.location.href = "popup.html";
        });
      }
    });
  } catch (error) {
    alert("Logout error: " + error.message);
  }
};
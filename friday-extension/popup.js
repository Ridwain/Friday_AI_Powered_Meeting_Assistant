chrome.storage.local.get(["email", "uid"], (result) => {
  if (result.email && result.uid) {
    window.location.href = "dashboard.html";
  } else {
    // Notify background script that extension page is available
    chrome.runtime.sendMessage({ type: "EXTENSION_PAGE_CONNECTED" });
  }
});

// Add message listener for transcript processing
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle new single-document transcript operations
  if (message.type === "INIT_TRANSCRIPT_DOC") {
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
  else if (message.type === "PROCESS_TRANSCRIPT_QUEUE") {
    // Process queued transcripts (legacy)
    processQueuedTranscripts(message.queue);
    sendResponse({ success: true });
  } else if (message.type === "SAVE_TRANSCRIPT_REQUEST") {
    // Handle direct transcript saving request (legacy)
    saveTranscriptToFirebase(
      message.uid,
      message.meetingId,
      message.transcript
    );
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
    const { db } = await import("./firebase-config.js");
    const { doc, setDoc, serverTimestamp } = await import(
      "./firebase/firebase-firestore.js"
    );

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

// Function to update transcript document in real-time
async function updateTranscriptDocument(
  uid,
  meetingId,
  docId,
  transcript,
  lastUpdated,
  status
) {
  try {
    const { db } = await import("./firebase-config.js");
    const { doc, updateDoc } = await import("./firebase/firebase-firestore.js");

    const transcriptDocRef = doc(
      db,
      "users",
      uid,
      "meetings",
      meetingId,
      "transcripts",
      docId
    );
    await updateDoc(transcriptDocRef, {
      transcript: transcript,
      lastUpdated: lastUpdated,
      status: status,
      wordCount: transcript
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 0).length,
    });
    console.log(
      `Updated transcript document: ${docId} (${transcript.length} chars)`
    );
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

// Function to finalize transcript document
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
    const { db } = await import("./firebase-config.js");
    const { doc, updateDoc, serverTimestamp } = await import(
      "./firebase/firebase-firestore.js"
    );

    const transcriptDocRef = doc(
      db,
      "users",
      uid,
      "meetings",
      meetingId,
      "transcripts",
      docId
    );
    await updateDoc(transcriptDocRef, {
      transcript: transcript,
      endTime: endTime,
      status: status,
      wordCount: wordCount,
      finalizedAt: serverTimestamp(),
    });
    console.log(`Finalized transcript document: ${docId} (${wordCount} words)`);
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

// Function to process queued transcripts (legacy support)
async function processQueuedTranscripts(queue) {
  const { db } = await import("./firebase-config.js");
  const { doc, setDoc, collection, serverTimestamp } = await import(
    "./firebase/firebase-firestore.js"
  );

  for (const item of queue) {
    try {
      const transcriptDocRef = doc(
        collection(
          db,
          "users",
          item.uid,
          "meetings",
          item.meetingId,
          "transcripts"
        )
      );
      await setDoc(
        transcriptDocRef,
        {
          content: item.transcript,
          timestamp: serverTimestamp(),
        },
        { merge: true }
      );
      console.log(`Processed queued transcript for meeting ${item.meetingId}`);
    } catch (error) {
      console.error("Error processing queued transcript:", error);
    }
  }

  // Also process any stored transcripts
  await processStoredTranscripts();
}

// Function to process transcripts stored in chrome.storage
async function processStoredTranscripts() {
  try {
    const allData = await chrome.storage.local.get();
    const transcriptKeys = Object.keys(allData).filter((key) =>
      key.startsWith("transcript_")
    );

    if (transcriptKeys.length > 0) {
      const { db } = await import("./firebase-config.js");
      const { doc, setDoc, collection, serverTimestamp } = await import(
        "./firebase/firebase-firestore.js"
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
    }
  } catch (error) {
    console.error("Error processing stored transcripts:", error);
  }
}

// Function to save transcript to Firebase (for direct requests - legacy)
async function saveTranscriptToFirebase(uid, meetingId, transcript) {
  try {
    const { db } = await import("./firebase-config.js");
    const { doc, setDoc, collection, serverTimestamp } = await import(
      "./firebase/firebase-firestore.js"
    );

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
    console.log("Transcript saved successfully via popup");
  } catch (err) {
    console.error("Failed to save transcript:", err);
  }
}

import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signInWithCredential,
  GoogleAuthProvider,
  signOut,
} from "./firebase/firebase-auth.js";
import { collection, getDocs } from "./firebase/firebase-firestore.js";

const loginBtn = document.getElementById("loginBtn");
const googleBtn = document.getElementById("googleBtn");
const status = document.getElementById("status");
const logoutBtn = document.getElementById("logoutBtn");
const loginForm = document.getElementById("loginForm");

// Handle form submission instead of button click to prevent page reload
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault(); // Prevent form from reloading the page

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  if (!email || !password) {
    status.innerText = "Please enter email and password.";
    return;
  }

  try {
    status.innerText = "Signing in...";
    const userCredential = await signInWithEmailAndPassword(
      auth,
      email,
      password
    );
    const user = userCredential.user;
    chrome.storage.local.set({ email: user.email, uid: user.uid }, () => {
      window.location.href = "dashboard.html"; // ✅ Redirect to dashboard
    });
  } catch (err) {
    status.innerText = `Login error: ${err.message}`;
  }
});

googleBtn.onclick = () => {
  // Use the new Web Application Client ID for secure flow
  const clientId = "837567341884-4dnaoequvhd1km5rhmogjiq3n7bav4it.apps.googleusercontent.com";
  const scopes = [
    "profile",
    "email",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/userinfo.email"
  ];

  // Generate a random state for CSRF protection
  const state = Math.random().toString(36).substring(7);
  chrome.storage.local.set({ oauth_state: state });

  // Get Chrome's built-in redirect URL for secure OAuth
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId}&` +
    `response_type=token&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${encodeURIComponent(scopes.join(" "))}&` +
    `state=${state}&` +
    `prompt=select_account`;

  status.innerText = "Opening secure login...";

  // Use Chrome's secure identity API instead of manual popup
  chrome.identity.launchWebAuthFlow(
    { url: authUrl, interactive: true },
    async (responseUrl) => {
      // Handle errors or user cancellation
      if (chrome.runtime.lastError || !responseUrl) {
        status.innerText = `Login cancelled or failed: ${chrome.runtime.lastError?.message || "Unknown error"}`;
        return;
      }

      try {
        const url = new URL(responseUrl);
        const hash = url.hash.substring(1);
        const params = new URLSearchParams(hash);

        // Verify state to prevent CSRF
        const returnedState = params.get("state");
        const storedState = await new Promise(resolve =>
          chrome.storage.local.get(['oauth_state'], res => resolve(res.oauth_state))
        );

        if (returnedState !== storedState) {
          status.innerText = "Security check failed: State mismatch.";
          return;
        }

        const accessToken = params.get("access_token");

        if (accessToken) {
          status.innerText = "Signing in with Firebase...";
          const credential = GoogleAuthProvider.credential(null, accessToken);
          const result = await signInWithCredential(auth, credential);
          const user = result.user;

          chrome.storage.local.set(
            { email: user.email, uid: user.uid },
            () => {
              window.location.href = "dashboard.html";
            }
          );
        } else {
          status.innerText = "Failed to get access token.";
        }
      } catch (error) {
        status.innerText = `Sign-in error: ${error.message}`;
        console.error(error);
      }
    }
  );
};

chrome.storage.local.get(["email", "uid"], async (result) => {
  if (result.email && result.uid) {
    status.innerText = `Welcome ${result.email}`;
    document.getElementById("logoutBtn").style.display = "block"; // ✅ Show logout
    loadMeetings(result.uid);
  } else {
    document.getElementById("logoutBtn").style.display = "none"; // ✅ Hide logout
  }
});

async function loadMeetings(uid) {
  const meetingsRef = collection(db, "users", uid, "meetings");
  const snapshot = await getDocs(meetingsRef);
  const container = document.getElementById("meetings");
  container.innerHTML = "";

  snapshot.forEach((doc) => {
    const data = doc.data();
    data.meetingId = doc.id;
    const div = document.createElement("div");
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <strong>${data.meetingDate} @ ${data.meetingTime}</strong><br>
      <a href="${data.meetingLink}" target="_blank">Join</a><br>
      <a href="${data.driveFolderLink}" target="_blank">Drive</a>
    `;
    container.appendChild(div);
  });
}

logoutBtn.onclick = async () => {
  try {
    await signOut(auth);
    chrome.storage.local.remove(["email", "uid"]);
    status.innerText = "Logged out.";
    document.getElementById("meetings").innerHTML = "";
  } catch (error) {
    status.innerText = `Logout error: ${error.message}`;
  }
};

// Open Side Panel
const openSidePanelBtn = document.getElementById("openSidePanelBtn");
if (openSidePanelBtn) {
  openSidePanelBtn.onclick = () => {
    // Open side panel for the current window
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        // We can't directly open side panel via API from popup in all cases, 
        // but we can request it via background or use window.close() if configured to open on action
        // For now, we'll try to use the sidePanel.open API if available (Chrome 114+)
        if (chrome.sidePanel && chrome.sidePanel.open) {
          chrome.sidePanel.open({ windowId: tabs[0].windowId })
            .catch(err => console.error("Failed to open side panel:", err));
          window.close(); // Close popup
        } else {
          status.innerText = "Side Panel API not available.";
        }
      }
    });
  };
}

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.9.0/firebase-app.js";
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, query, orderBy, onSnapshot, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.9.0/firebase-auth.js";

const isLocalhost = window.location.hostname.includes("localhost") || window.location.hostname === "127.0.0.1";

const firebaseConfig = {
  apiKey: "AIzaSyCQkiNi5bsfoOUxj9HsxDupXR7SmUHGKPI",
  authDomain: isLocalhost
    ? "friday-e65f2.firebaseapp.com"
    : "friday-e65f2.web.app",
  projectId: "friday-e65f2",
  storageBucket: "friday-e65f2.appspot.com",
  messagingSenderId: "837567341884",
  appId: "1:837567341884:web:1c940bd2cfdce899252a39"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// DOM Elements - Main
const userNameSpan = document.getElementById("user-name");
const userPicImg = document.getElementById("user-pic");
const logoutBtn = document.getElementById("logout-btn");
const meetingForm = document.getElementById("meeting-form");
const meetingsList = document.getElementById("meetings-list");

// Backend API URL
const API_BASE_URL = isLocalhost ? "http://localhost:3001" : "https://friday-backend-production.up.railway.app"; // Replace with actual prod URL

// Main Form Inputs
const dateInput = document.getElementById("meeting-date");
const timeInput = document.getElementById("meeting-time");
const meetingLinkInput = document.getElementById("meeting-link");
const driveFolderInput = document.getElementById("drive-folder-link");
const pickDriveBtn = document.getElementById("pick-drive-folder-btn"); // NEW

// Modal Elements
const editModal = document.getElementById("edit-modal");
const editMeetingForm = document.getElementById("edit-meeting-form");
const closeEditBtn = document.getElementById("close-edit-btn");

// Modal Inputs
const editDateInput = document.getElementById("edit-date");
const editTimeInput = document.getElementById("edit-time");
const editLinkInput = document.getElementById("edit-link");
const editDriveInput = document.getElementById("edit-drive");
const editPickDriveBtn = document.getElementById("edit-pick-drive-btn"); // NEW

let currentUser = null;
let editingMeetingId = null;

function isValidURL(str) {
  try { new URL(str); return true; } catch { return false; }
}

function extractFolderId(link) {
  const m = link.match(/\/folders\/([\w-]+)/);
  return m ? m[1] : null;
}

// Auth State Listener
onAuthStateChanged(auth, user => {
  if (!user) {
    window.location.replace("index.html");
    return;
  }
  currentUser = user;
  userNameSpan.textContent = user.displayName || user.email || "User";
  if (user.photoURL) {
    userPicImg.src = user.photoURL;
    userPicImg.style.display = "inline-block";
  }
  loadMeetings();
});

logoutBtn.addEventListener("click", () => {
  signOut(auth)
    .then(() => {
      window.location.replace("index.html");
    })
    .catch(err => alert("Logout failed"));
});

// --- Create Meeting Logic ---
meetingForm.addEventListener("submit", async e => {
  e.preventDefault();
  const date = dateInput.value;
  const time = timeInput.value;
  const link = meetingLinkInput.value.trim();
  const drive = driveFolderInput.value.trim();

  if (!date || !time || !isValidURL(link) || !isValidURL(drive)) {
    return alert("Please fill all fields with valid URLs.");
  }

  const data = {
    meetingDate: date,
    meetingTime: time,
    meetingLink: link,
    driveFolderLink: drive,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const ref = collection(db, "users", currentUser.uid, "meetings");
  try {
    await addDoc(ref, data);
    alert("Meeting created");
    meetingForm.reset();
  } catch (err) {
    console.error(err);
    alert("Failed to save meeting.");
  }
});

// --- Edit Meeting Modal Logic ---

// Close Modal Handler
const closeModal = () => {
  editModal.classList.remove("active");
  editMeetingForm.reset();
  editingMeetingId = null;
};

closeEditBtn.addEventListener("click", closeModal);
editModal.addEventListener("click", (e) => {
  if (e.target === editModal) closeModal();
});

// Submit Edit
editMeetingForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editingMeetingId) return;

  const date = editDateInput.value;
  const time = editTimeInput.value;
  const link = editLinkInput.value.trim();
  const drive = editDriveInput.value.trim();

  if (!date || !time || !isValidURL(link) || !isValidURL(drive)) {
    return alert("Please fill all fields with valid URLs.");
  }

  const data = {
    meetingDate: date,
    meetingTime: time,
    meetingLink: link,
    driveFolderLink: drive,
    updatedAt: serverTimestamp(),
  };

  try {
    const ref = doc(db, "users", currentUser.uid, "meetings", editingMeetingId);
    await updateDoc(ref, data);
    alert("Meeting updated successfully");
    closeModal();
  } catch (err) {
    console.error("Update error:", err);
    alert("Failed to update meeting.");
  }
});

// --- Loading & Rendering ---
function loadMeetings() {
  const ref = collection(db, "users", currentUser.uid, "meetings");
  const q = query(ref, orderBy("meetingDate", "asc"), orderBy("meetingTime", "asc"));

  onSnapshot(q, snap => {
    meetingsList.innerHTML = "";
    if (snap.empty) return meetingsList.innerHTML = "<li>No meetings found.</li>";
    snap.forEach(ds => renderMeeting(ds.id, ds.data()));
  });
}

function renderMeeting(id, data) {
  const folderId = extractFolderId(data.driveFolderLink);
  const fileListId = `file-list-${id}`;

  const li = document.createElement("li");
  li.style.marginBottom = "20px";

  const info = document.createElement("div");
  const when = data.meetingDate && data.meetingTime ? `${data.meetingDate} ${data.meetingTime}` : "Invalid date/time";
  info.innerHTML = `
    <strong>Date & Time:</strong> ${when}<br>
    <strong>Meeting Link:</strong> <a href="${data.meetingLink}" target="_blank">${data.meetingLink}</a><br>
    <strong>Drive Folder:</strong> <a href="${data.driveFolderLink}" target="_blank">${data.driveFolderLink}</a><br><br>`;
  li.appendChild(info);

  const ul = document.createElement("ul");
  ul.id = fileListId;
  ul.style.display = "none";
  li.appendChild(ul);

  const toggleBtn = document.createElement("button");
  toggleBtn.textContent = "Show Files";
  let showing = false;
  toggleBtn.addEventListener("click", async () => {
    if (!showing) {
      toggleBtn.textContent = "Hide Files";
      ul.style.display = "block";
      folderNavigationStack[fileListId] = [];
      if (!ul.hasChildNodes()) await showFilesFromDrive(folderId, fileListId);
      showing = true;
    } else {
      toggleBtn.textContent = "Show Files";
      ul.style.display = "none";
      showing = false;
    }
  });
  li.appendChild(toggleBtn);

  const actions = document.createElement("div");
  actions.style.marginTop = "10px";

  const edit = document.createElement("button");
  edit.textContent = "Edit";
  edit.className = "btn btn-outline btn-sm";
  edit.style.marginRight = "10px";
  edit.addEventListener("click", () => onEditMeeting(id)); // Triggers Modal
  actions.appendChild(edit);

  const del = document.createElement("button");
  del.textContent = "Delete";
  del.className = "btn btn-outline btn-sm";
  del.style.borderColor = "#ef4444";
  del.style.color = "#ef4444";
  del.addEventListener("click", () => onDeleteMeeting(id));
  actions.appendChild(del);

  li.appendChild(actions);
  meetingsList.appendChild(li);
}

// Triggered by Edit button
async function onEditMeeting(id) {
  try {
    const docRef = doc(db, "users", currentUser.uid, "meetings", id);
    const ds = await getDoc(docRef);
    if (!ds.exists()) return alert("Meeting not found.");

    const d = ds.data();

    // Populate Modal Inputs
    editDateInput.value = d.meetingDate;
    editTimeInput.value = d.meetingTime;
    editLinkInput.value = d.meetingLink;
    editDriveInput.value = d.driveFolderLink;

    editingMeetingId = id;

    // Show Modal
    editModal.classList.add("active");

  } catch (err) {
    console.error(err);
    alert("Error loading meeting details");
  }
}

async function onDeleteMeeting(id) {
  if (!confirm("Delete this meeting?")) return;
  await deleteDoc(doc(db, "users", currentUser.uid, "meetings", id));
  alert("Meeting deleted.");
}

// --- Google Drive API & Picker Logic ---

let gapiInitialized = false;
let pickerInitialized = false;
const folderNavigationStack = {};

function initGapiClient() {
  return new Promise((resolve, reject) => {
    // Load both 'client' for API calls and 'picker' for the UI
    gapi.load('client:picker', async () => {
      try {
        await gapi.client.init({
          apiKey: "AIzaSyCQkiNi5bsfoOUxj9HsxDupXR7SmUHGKPI",
          discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"]
        });
        gapiInitialized = true;
        pickerInitialized = true;
        resolve();
      } catch (error) {
        console.error("API init error:", error);
        reject(error);
      }
    });
  });
}

// --- PKCE Helper Functions ---

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, "0")).join("");
}

// --- OAuth Authorization Code Flow (Server-Side Redirect) ---

const CLIENT_ID_PROD = "837567341884-0qp9pv773cmos8favl2po8ibhkkv081s.apps.googleusercontent.com"; // Web Client (Live)
const CLIENT_ID_DEV = "837567341884-hk6ldlrhdlg0cqnadebgg7s41h1s6l24.apps.googleusercontent.com";   // Web Client Dev (Localhost)

/**
 * Handle OAuth return - check if we're returning from OAuth flow
 * Called on page load to process the access token from URL
 */
function handleOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const accessToken = params.get("access_token");
  const expiresIn = params.get("expires_in");
  const error = params.get("error");

  if (error) {
    console.error("OAuth error:", error);
    alert("Authorization failed: " + error);
    // Clean URL
    window.history.replaceState({}, "", window.location.pathname);
    return false;
  }

  if (accessToken) {
    console.log("✅ OAuth complete, token received from server callback");

    // Store token for gapi
    gapi.client.setToken({ access_token: accessToken });

    // Store expiry time
    const expiryTime = Date.now() + (parseInt(expiresIn) || 3600) * 1000;
    sessionStorage.setItem("oauth_token_expiry", expiryTime.toString());

    // Clean URL (remove token from visible URL for security)
    window.history.replaceState({}, "", window.location.pathname);

    return true;
  }

  return false;
}

/**
 * Request access token using redirect flow
 * Redirects to Google, backend handles callback
 */
async function requestAccessToken() {
  // 1. Generate PKCE & State
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // 2. Store locally (backup)
  sessionStorage.setItem("oauth_state", state);
  sessionStorage.setItem("oauth_code_verifier", codeVerifier);

  // 3. Send to backend for storage
  const frontendRedirect = window.location.origin + window.location.pathname;

  try {
    const initResponse = await fetch(`${API_BASE_URL}/oauth/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: state,
        code_verifier: codeVerifier,
        frontend_redirect: frontendRedirect
      })
    });

    if (!initResponse.ok) {
      throw new Error("Failed to initialize OAuth flow");
    }

    console.log("✅ OAuth init successful, redirecting to Google...");

  } catch (err) {
    console.error("OAuth init error:", err);
    throw err;
  }

  // 4. Build Google Auth URL and redirect
  const CLIENT_ID = isLocalhost ? CLIENT_ID_DEV : CLIENT_ID_PROD;
  const REDIRECT_URI = `${API_BASE_URL}/oauth/callback`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/drive.readonly");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  // Redirect to Google (using replace to avoid back button issues)
  window.location.replace(authUrl.toString());

  // This promise won't resolve because page redirects
  // Token will be available on return via handleOAuthReturn()
  return new Promise(() => { });
}

/**
 * Check if we have a valid token
 */
function hasValidToken() {
  const token = gapi.client.getToken();
  if (!token) return false;

  const expiry = sessionStorage.getItem("oauth_token_expiry");
  if (expiry && Date.now() > parseInt(expiry)) {
    // Token expired
    gapi.client.setToken(null);
    return false;
  }

  return true;
}


// Generic Picker Launcher
async function openDrivePicker(targetInput) {
  try {
    if (!gapiInitialized) await initGapiClient();

    // Check if we just returned from OAuth with a token
    handleOAuthReturn();

    // Check if we have a valid token
    if (!hasValidToken()) {
      // No token - start OAuth flow (will redirect)
      await requestAccessToken();
      return; // Page will redirect, so we stop here
    }

    if (!pickerInitialized) {
      alert("Google Picker API not loaded yet. Please try again.");
      return;
    }

    const oauthToken = gapi.client.getToken().access_token;

    // Build the Picker
    // ViewId.FOLDERS to select folders
    // Use DocsView for folder selection (View does not support setSelectFolderEnabled)
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
    view.setMimeTypes("application/vnd.google-apps.folder");
    view.setSelectFolderEnabled(true);
    view.setIncludeFolders(true); // Ensure folders are shown

    const picker = new google.picker.PickerBuilder()
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .setAppId("837567341884")
      .setOAuthToken(oauthToken)
      .addView(view)
      .setDeveloperKey("AIzaSyCQkiNi5bsfoOUxj9HsxDupXR7SmUHGKPI")
      .setCallback((data) => {
        if (data[google.picker.Response.ACTION] === google.picker.Action.PICKED) {
          const doc = data[google.picker.Response.DOCUMENTS][0];
          const folderUrl = doc[google.picker.Document.URL];
          // Update the input
          targetInput.value = folderUrl;
        }
      })
      .build();

    picker.setVisible(true);

  } catch (err) {
    console.error("Error opening picker:", err);
    alert("Failed to open Drive Picker: " + (err.message || JSON.stringify(err)));
  }
}

// Listeners for Picker Buttons
pickDriveBtn.addEventListener("click", () => openDrivePicker(driveFolderInput));
editPickDriveBtn.addEventListener("click", () => openDrivePicker(editDriveInput));


// --- Existing Drive File Listing Logic (Untouched) ---

async function showFilesFromDrive(folderId, containerId) {
  if (!folderId) return;
  const ul = document.getElementById(containerId);
  ul.innerHTML = "";

  const back = document.createElement("button");
  back.textContent = "⬅ Back";
  back.disabled = !(folderNavigationStack[containerId]?.length);
  back.addEventListener("click", () => {
    if (folderNavigationStack[containerId].length) {
      const prevId = folderNavigationStack[containerId].pop();
      showFilesFromDrive(prevId, containerId);
    }
  });
  ul.appendChild(back);

  const label = document.createElement("strong");
  label.textContent = folderNavigationStack[containerId]?.length ? " Subfolder" : " Root";
  label.style.marginLeft = "10px";
  ul.appendChild(label);

  try {
    if (!gapiInitialized) await initGapiClient();

    // Check for token on return
    handleOAuthReturn();

    if (!hasValidToken()) {
      await requestAccessToken();
      return; // Page will redirect
    }

    const resp = await gapi.client.drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id,name,mimeType,webViewLink)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = resp.result.files || [];
    if (!files.length) return ul.appendChild(document.createElement("li")).textContent = "No files found.";

    for (let f of files) {
      const li = document.createElement("li");
      if (f.mimeType === "application/vnd.google-apps.folder") {
        li.innerHTML = `📁 <strong>${f.name}</strong>`;
        li.style.cursor = "pointer";
        li.addEventListener("click", () => {
          folderNavigationStack[containerId] ??= [];
          folderNavigationStack[containerId].push(folderId);
          showFilesFromDrive(f.id, containerId);
        });
      } else {
        li.innerHTML = `<a href="${f.webViewLink}" target="_blank">${f.name}</a>`;
      }
      ul.appendChild(li);
    }
  } catch (err) {
    console.error("Drive API error:", err);
    ul.appendChild(document.createElement("li")).textContent = "Failed to load files.";
  }
}

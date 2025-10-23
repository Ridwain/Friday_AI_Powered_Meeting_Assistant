# An Chrome extension including a rag system chatbot

RAG-based in-meeting helper that answers questions with **citations** from your **live transcript**, **Google Drive files**, and optional **web snippets** — all inside a lightweight Chrome (MV3) extension with a companion web dashboard and a Node/Express backend.

> **Modules:** Website (Firebase Auth/Firestore) · Chrome MV3 Extension (content scripts + service worker) · Backend (Node/Express) · Vector DB (Pinecone) · LLM + Embeddings (OpenAI) · Optional Web Search (SerpAPI)

---

## Table of Contents

* [Features](#features)
* [Architecture](#architecture)
* [Tech Stack](#tech-stack)
* [Repository Structure](#repository-structure)
* [Quick Start](#quick-start)
* [Configuration](#configuration)

  * [Firebase (Web)](#firebase-web)
  * [Backend `.env`](#backend-env)
  * [Pinecone Setup](#pinecone-setup)
* [Usage](#usage)
* [Security & Privacy](#security--privacy)
* [Known Limitations](#known-limitations)
* [Roadmap](#roadmap)
* [Contributing](#contributing)
* [License](#license)

---

## Features

* **Grounded answers with sources**
  Retrieval-Augmented Generation (RAG) over:

  1. Meeting transcript (live + archived), 2) Google Drive files, 3) optional web snippets.
* **Live meeting overlay (Chrome MV3)**
  Floating chat UI on Google Meet via content scripts; service worker handles messaging.
* **Companion website**
  Create meetings, attach Drive folders, manage resources (same Firebase project).
* **Citations you can trust**
  Span/timestamp-level snippet previews; click-to-verify design.
* **Low-latency responses (≈ 2–3s target)**
  Namespace-scoped vector search, embedding caches, compact prompts.
* **Least-privilege OAuth**
  Narrow Google Drive scopes; per-user isolation in Firestore and vector namespaces.

---

## Architecture

```mermaid
flowchart LR
  U[User] ---|Auth| Web[Website (Firebase)]
  U ---|Overlay| Ext[Chrome MV3 Extension]
  Ext <--->|runtime messaging| SW[Service Worker]
  SW <---> BE[Backend (Node/Express)]
  BE <---> Pinecone[(Pinecone Vector DB)]
  BE <---> OpenAI[(OpenAI: Embeddings & LLM)]
  Ext <---> GDrive[(Google Drive API)]
  Web <---> Firestore[(Firebase Firestore)]
  Ext <---> Firestore
```

**Retrieval namespaces**

* `meeting:{id}-transcript` — live/archived transcript chunks
* `meeting:{id}-drive` — Drive file chunks
* Optional `meeting:{id}-web` — cached web snippets (when requested)

---

## Tech Stack

* **Frontend (Website):** HTML, CSS, JS, Firebase Auth/Firestore
* **Extension (MV3):** `manifest.json`, content scripts, service worker, runtime messaging
* **Backend:** Node.js / Express
* **Vector Search:** Pinecone (cosine similarity, namespaces)
* **LLM/Embeddings:** OpenAI API
* **Web Search (optional):** SerpAPI

---

## Repository Structure

```
/website
  ├─ index.html
  ├─ dashboard.html
  ├─ style.css
  ├─ dashboard.css
  ├─ firebase.js
  ├─ firebase_logged.js
  ├─ form_toggle.js
  └─ oauth2callback.html

/extension
  ├─ manifest.json
  ├─ popup.html
  ├─ popup.js
  ├─ chat.html
  ├─ chat.js
  ├─ dashboard.html          # extension's dashboard (not the same as website)
  ├─ dashboard.js
  ├─ background.js           # MV3 service worker
  ├─ transcription-content.js
  ├─ enhanced-ai-helper.js
  ├─ web-scraper.js
  ├─ firebase-config.js      # <-- fill with your Firebase web config
  └─ google-signin.html

/backend
  └─ server.js               # Express server (RAG endpoints, OpenAI, Pinecone, SerpAPI)

/docs (optional)
  └─ report.tex              # your LaTeX report and assets
```

> Names above reflect the project files you’ve been working with. Adjust paths if yours differ.

---

## Quick Start

### 1) Clone

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
```

### 2) Backend

```bash
cd backend
npm install
# create .env (see below)
npm run dev   # or: node server.js
```

### 3) Website (static)

Use any static server to preview:

```bash
# from repo root
npx serve website   # or use your preferred static server/hosting
```

### 4) Chrome Extension (MV3)

1. Open `chrome://extensions`
2. Toggle **Developer mode**
3. **Load unpacked** → select the `/extension` folder
4. Pin the extension; open popup → **Login** → test flows on Google Meet

---

## Configuration

### Firebase (Web)

Create a Firebase project:

1. Enable **Authentication** (Email/Password and Google Sign-In if you use it).
2. Create **Firestore** (in production or test mode as needed).
3. Copy your web app config and paste into `/extension/firebase-config.js` and the website’s `firebase.js`:

```js
// example
export const firebaseConfig = {
  apiKey: "XXX",
  authDomain: "XXX.firebaseapp.com",
  projectId: "XXX",
  storageBucket: "XXX.appspot.com",
  messagingSenderId: "XXX",
  appId: "XXX"
};
```

**Firestore structure (typical)**

```
users/{uid}/meetings/{meetingId}
  - title, date, time, meetingLink, driveFolderUrl
  - other metadata (e.g., chat log refs)
```

### Backend `.env`

Create `/backend/.env`:

```ini
PORT=8080

# OpenAI
OPENAI_API_KEY=sk-...

# Pinecone
PINECONE_API_KEY=...
PINECONE_ENVIRONMENT=...
PINECONE_INDEX=friday-index

# Optional web search
SERPAPI_API_KEY=...

# CORS / origins
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8080
```

### Pinecone Setup

* Create an index (e.g., `friday-index`) with cosine similarity.
* The app uses per-meeting **namespaces** like:

  * `meeting:{id}-transcript`
  * `meeting:{id}-drive`

---

## Usage

### 1) Create a meeting (Website)

* Login → **Create Meeting** → add **date/time**, **meeting link**, **Drive folder**.

### 2) Join the meeting (Chrome)

* Open Google Meet page → open extension → **Login** (same account).
* Select the meeting → you’ll see a floating **Ask AI** button/window.

### 3) Ask questions with citations

* Type or use voice input in the floating chat.
* The assistant retrieves from:

  * **Transcript** (time-biased to recent windows)
  * **Drive files** (PDF, DOCX, PPT, TXT after text extraction)
  * **Web snippets** (only if requested)
* Answers include **snippet previews** + **timestamps** / **headings**.

### 4) Transcription

* Start/Stop transcription from the extension.

  * **Windows:** uses Stereo Mix + mic (clean digital capture).
  * **macOS:** mic captures room + speaker output (functional, may add noise).

---

## Security & Privacy

* **Least-privilege OAuth** for Drive scopes; only what’s needed.
* **Per-user isolation** in Firestore and Pinecone **namespaces**.
* No raw data is logged beyond intended features; add retention/deletion controls as needed.
* The extension overlays the meeting page; it does **not** join as a bot participant.

---

## Known Limitations

* **macOS transcription** quality is lower without a loopback device.
* **Auth flows** in extension (Google Sign-In) may require correct OAuth redirect setup.
* **Costs**: OpenAI/Pinecone/SerpAPI usage beyond free tiers.
* **File types**: Non-text (images) require OCR to be indexed (future work).

---

## Roadmap

* ✅ Multi-namespace RAG (transcripts + Drive + optional web)
* ✅ Floating chat with voice in/out and citations
* ⏩ Speaker diarization (“who said what”)
* ⏩ macOS/Ubuntu loopback audio option for cleaner transcription
* ⏩ Advanced dashboards (auto-summary, action items, analytics)
* ⏩ Team/Org spaces, role-based permissions
* ⏩ Cost controls (hybrid local/cloud embeddings)

---

## Contributing

PRs welcome!
Please open an issue for feature requests, bugs, or questions. When contributing code, follow the existing structure and keep credentials out of source control.

---

## License

MIT © <your-name>
*(Replace with your desired license if different.)*

---

### Acknowledgements

* Firebase, Pinecone, OpenAI, and SerpAPI for developer-friendly APIs.
* Chrome Extensions (MV3) platform for enabling in-page overlays.

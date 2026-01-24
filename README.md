# Friday - AI Powered Meeting Assistant

![Friday Logo](friday-extension/friday.png)

> **AI-powered meeting assistant that answers questions with citations from your live transcript, Google Drive files, and optional web snippets — all inside a lightweight Chrome (MV3) extension.**

Friday integrates seamlessly with Google Meet and Zoom to provide real-time intelligence, ensuring you never miss a beat during your meetings.

---

## Table of Contents

* [Features](#features)
* [Architecture](#architecture)
* [Tech Stack](#tech-stack)
* [Project Structure](#project-structure)
* [Prerequisites](#prerequisites)
* [Installation](#installation)
  * [1. Backend Setup](#1-backend-setup)
  * [2. Extension Setup](#2-extension-setup)
  * [3. Configuration](#3-configuration)
* [Usage](#usage)
* [Security](#security)
* [Roadmap](#roadmap)
* [Contributing](#contributing)
* [License](#license)

---

## Features

*   **RAG AI Assistant**: Advanced Retrieval-Augmented Generation system that answers queries using context from live meeting transcripts and connected Google Drive documents.
*   **Companion Website Integration**: A dedicated dashboard (`/public`) for managing meetings. Built-in **Google Drive Picker API** integration allows users to easily browse and select Drive folders to link with meetings.
*   **Secure Authentication**: Robust security using **Google OAuth 2.0** for safe, least-privilege access to user profiles and Drive files.
*   **Live Chat Overlay**: Non-intrusive floating side panel that provides AI responses with direct citation links to source material.
*   **Platform Support**: Native support for **Google Meet** and **Zoom**.
*   **Trustworthy Citations**: Every AI answer comes with click-to-verify citations, showing exactly where the information came from (transcript timestamp or document page).

---

## Architecture

The system consists of three main components working in harmony:

1.  **Chrome Extension (Client)**: Captures audio, renders the UI, and handles user interaction overlay.
2.  **Python Backend (Brain)**: Manages the RAG pipeline, processes embeddings, and communicates with the LLM.
3.  **Firebase & Google Cloud (Infrastructure)**: Handles authentication, database storage, and file access.

---

## Tech Stack

*   **Authentication**: Google OAuth 2.0
*   **Integrations**: Google Drive Picker API
*   **Extension**: Chrome Extension Manifest V3, JavaScript, Firebase Auth
*   **Backend**: Python (FastAPI), LangChain
*   **Vector Database**: Pinecone (for semantic search)
*   **LLM & Embeddings**: Google Gemini API
*   **Website**: Static HTML/JS, Firebase Hosting, Firestore
*   **Build Tools**: Node.js (Webpack)

---

## Project Structure

```bash
Friday/
├── friday-extension/    # Chrome Extension (MV3) - The client-side assistant
├── python-backend/      # FastAPI Server - Handles RAG, Embeddings, and LLM logic
├── public/              # Companion Website - Dashboard for managing meetings
└── package.json         # Build dependencies (Webpack, Firebase)
```

---

## Prerequisites

Before you begin, ensure you have the following installed/set up:

*   **Python 3.11.2**: Required for the backend server.
*   **Node.js**: Required for Webpack bundling and running Firebase CLI tools.
*   **Firebase Account**: For Authentication and Firestore database.
*   **API Keys**: You will need valid API keys for:
    *   Google Gemini (AI Studio)
    *   Pinecone (Vector DB)
    *   Deepgram (Transcription)

---

## Installation

### 1. Backend Setup

Navigate to the backend directory and set up the environment:

```bash
cd python-backend

# Activate the virtual environment
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install Python dependencies
pip install -r requirements.txt
```

Create a `.env` file in `python-backend/.env` with your credentials:

```ini
PORT=3001

# Google AI
GOOGLE_API_KEY=your_gemini_api_key

# Pinecone
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_ENVIRONMENT=us-east-1
PINECONE_INDEX_NAME=friday-index

# Optional: Web Search
SERP_API_KEY=your_serp_api_key

# Development
ALLOW_ALL_EXTENSIONS=true
```

Start the backend server:

```bash
python run.py
```

### 2. Extension Setup

1.  Open Chrome and navigate to `chrome://extensions`.
2.  Toggle **Developer mode** in the top right corner.
3.  Click **Load unpacked**.
4.  Select the **`friday-extension`** folder from the project directory.

### 3. Configuration

**Firebase Config**:
Update `friday-extension/firebase-config.js` and `public/firebase.js` with your Firebase project details:

```javascript
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

---

## Usage

1.  **Start the Backend**: Ensure `python run.py` is running.
2.  **Create a Meeting**: Go to the companion website (`public/index.html` or deployed URL), log in, and create a meeting entry. You can attach Google Drive folders here.
3.  **Join the Meeting**: Open Google Meet or Zoom.
4.  **Activate Friday**: Open the Chrome Extension popup and click **Login**.
5.  **Ask & Interact**: Use the floating side panel to ask questions. Friday will answer using context from the current conversation and attached files.

---

## Security

*   **OAuth 2.0**: We strictly use Google OAuth 2.0 for all authentication flows, ensuring secure and standard access delegation.
*   **Data Isolation**: User data is isolated in Firestore and Pinecone using unique namespaces.
*   **Least Privilege**: The application requests only the minimum necessary permissions (e.g., `drive.readonly`) to function.

---

## Roadmap

*   [ ] **Real-time Transcription**: Integration of Deepgram for high-accuracy live transcription (currently in development).
*   [ ] **Speaker Diarization**: improved identification of "who said what".
*   [ ] **Advanced Analytics**: Meeting summaries and action item extraction.

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1.  Fork the project
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`)
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4.  Push to the branch (`git push origin feature/AmazingFeature`)
5.  Open a Pull Request

---

## License

Distributed under the MIT License. See `LICENSE` for more information.

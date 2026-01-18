# Python Backend for Friday Chrome Extension

A Python + FastAPI server with LangChain integration, designed as an alternative to the Node.js backend.

## Quick Start

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run server
python run.py
```

Server will start at `http://localhost:3001`

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/stats` | GET | Pinecone stats |
| `/parse-file` | POST | Parse PDF, DOCX, PPTX |
| `/ai/embed` | POST | Generate embeddings |
| `/ai/stream` | POST | Chat completion (SSE) |
| `/search` | POST | Vector search |
| `/upsert` | POST | Add vectors |
| `/delete` | POST | Delete vectors |

## Switching from Node.js

In your extension's `config.js`:
```javascript
// Use Python backend
SERVER_URL: "http://localhost:3001"

// Or switch back to Node.js
// SERVER_URL: "http://localhost:3000"
```

## Environment Variables

Copy `.env.example` to `.env` and fill in your API keys.

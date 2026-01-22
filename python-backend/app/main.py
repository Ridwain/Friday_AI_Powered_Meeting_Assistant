"""
Friday Python Backend - Main Application
FastAPI server with LangChain integration
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import time
import re

from app.config import settings, validate_settings
from app.routes import health, parse, search, chat, embed, scrape, serp, drive

# Validate settings on startup
validate_settings()

# Create FastAPI app
app = FastAPI(
    title="Friday Python Backend",
    description="LangChain-powered AI backend for Friday Chrome Extension",
    version="2.0.0"
)

# CORS Configuration
def is_allowed_origin(origin: str) -> bool:
    if not origin:
        return True
    
    # Allow localhost variations
    if origin.startswith("http://localhost") or origin.startswith("http://127.0.0.1"):
        return True
    
    # Allow Chrome extensions
    if settings.ALLOW_ALL_EXTENSIONS and origin.startswith("chrome-extension://"):
        return True
    
    # Check allowlist
    return origin in settings.CORS_ORIGINS

# Custom CORS middleware for Chrome extension support
@app.middleware("http")
async def cors_middleware(request: Request, call_next):
    origin = request.headers.get("origin", "")
    
    # Handle preflight
    if request.method == "OPTIONS":
        response = JSONResponse(content={})
        response.headers["Access-Control-Allow-Origin"] = origin if is_allowed_origin(origin) else ""
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-API-Key"
        response.headers["Access-Control-Allow-Credentials"] = "true"
        return response
    
    response = await call_next(request)
    
    if is_allowed_origin(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
    
    return response

# Rate limiting state
rate_limit_store = {}
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX = 500  # requests per window

@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    client_ip = request.client.host
    current_time = time.time()
    
    if client_ip in rate_limit_store:
        requests, window_start = rate_limit_store[client_ip]
        if current_time - window_start > RATE_LIMIT_WINDOW:
            rate_limit_store[client_ip] = (1, current_time)
        elif requests >= RATE_LIMIT_MAX:
            print(f"⚠️ Rate limit exceeded for IP: {client_ip}")
            return JSONResponse(
                status_code=429,
                content={"error": "Too many requests. Please wait before trying again."}
            )
        else:
            rate_limit_store[client_ip] = (requests + 1, window_start)
    else:
        rate_limit_store[client_ip] = (1, current_time)
    
    return await call_next(request)

# Include routers
app.include_router(health.router, tags=["Health"])
app.include_router(parse.router, tags=["Parsing"])
app.include_router(search.router, tags=["Search"])
app.include_router(chat.router, tags=["Chat"])
app.include_router(embed.router, tags=["Embedding"])
app.include_router(scrape.router, tags=["Web Scraping"])
app.include_router(serp.router, tags=["Search Engine"])
app.include_router(drive.router, tags=["Google Drive"])

# OAuth Router (Authorization Code Flow)
try:
    from app.routes import oauth
    app.include_router(oauth.router, tags=["OAuth"])
    print("✅ OAuth routes enabled")
except ImportError as e:
    print(f"⚠️ OAuth routes not available: {e}")

# LangChain RAG Chat (with memory)
try:
    from app.routes import rag_chat
    app.include_router(rag_chat.router, tags=["RAG Chat"])
    print("✅ LangChain RAG Chat enabled")
except ImportError as e:
    print(f"⚠️ LangChain RAG Chat not available: {e}")

# Startup event
@app.on_event("startup")
async def startup_event():
    print(f"""
🚀 Friday Python Backend v2.0 (Unified Backend)
   Running at http://localhost:{settings.PORT}

📊 Pinecone Index: {settings.PINECONE_INDEX_NAME}

🔒 Security Features:
   - Strict CORS: {'Enabled' if not settings.ALLOW_ALL_EXTENSIONS else 'Dev mode (all extensions)'}
   - Rate Limiting: {RATE_LIMIT_MAX} req/min

📡 Available endpoints:
   GET  /health         - Health check
   GET  /stats          - Pinecone stats
   POST /search         - Semantic search
   POST /upsert         - Upsert vectors
   POST /delete         - Delete vectors
   POST /parse-file     - Parse PDF, DOCX, XLSX, Images, etc.
   POST /ai/embed       - Get embeddings
   POST /ai/stream      - Chat completion (SSE)
   POST /scrape-url     - Scrape web URL
   POST /scrape-and-upsert - Scrape and index
   POST /serp/search    - Google search proxy
   POST /drive/sync     - Sync Google Drive folder

✅ Server ready! (Node.js backend deprecated)
""")

# Shutdown event
@app.on_event("shutdown")
async def shutdown_event():
    print("🛑 Gracefully shutting down server...")


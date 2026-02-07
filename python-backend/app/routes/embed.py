"""Embedding endpoint using Google GenAI SDK"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import hashlib

from google import genai
from app.config import settings

router = APIRouter()

# Initialize genai client
_client = None

def get_genai_client():
    """Get or create genai client"""
    global _client
    if _client is None:
        _client = genai.Client(api_key=settings.GOOGLE_API_KEY)
    return _client

# Simple embedding cache
embedding_cache = {}
MAX_CACHE_SIZE = 1000

class EmbedRequest(BaseModel):
    text: str

class EmbedResponse(BaseModel):
    embedding: List[float]
    cached: bool = False

def get_cache_key(text: str) -> str:
    """Generate cache key for text"""
    return hashlib.md5(text.encode()).hexdigest()


async def get_embedding_internal(text: str) -> Optional[List[float]]:
    """
    Internal function to get embedding for text.
    Used by drive.py and other internal modules.
    """
    if not text or len(text.strip()) < 10:
        return None
    
    trimmed = text[:8000]
    cache_key = get_cache_key(trimmed)
    
    # Check cache
    if cache_key in embedding_cache:
        return embedding_cache[cache_key]
    
    try:
        client = get_genai_client()
        result = client.models.embed_content(
            model="gemini-embedding-001",
            contents=trimmed,
            config={"output_dimensionality": 768}
        )
        
        embedding = list(result.embeddings[0].values)
        
        # Cache
        if len(embedding_cache) < MAX_CACHE_SIZE:
            embedding_cache[cache_key] = embedding
        
        return embedding
        
    except Exception as e:
        print(f"❌ Embedding error: {str(e)}")
        return None


@router.post("/ai/embed", response_model=EmbedResponse)
async def get_embedding(request: EmbedRequest):
    """Generate embedding for text using Google GenAI"""
    
    if not request.text or len(request.text.strip()) < 10:
        raise HTTPException(status_code=400, detail="Text too short for embedding")
    
    # Check cache first
    cache_key = get_cache_key(request.text[:8000])
    if cache_key in embedding_cache:
        return EmbedResponse(embedding=embedding_cache[cache_key], cached=True)
    
    try:
        client = get_genai_client()
        
        result = client.models.embed_content(
            model="gemini-embedding-001",
            contents=request.text[:8000],
            config={"output_dimensionality": 768}
        )
        
        embedding = list(result.embeddings[0].values)
        
        # Cache the result
        if len(embedding_cache) < MAX_CACHE_SIZE:
            embedding_cache[cache_key] = embedding
        
        return EmbedResponse(embedding=embedding, cached=False)
        
    except Exception as e:
        print(f"❌ Embedding error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Embedding failed: {str(e)}")

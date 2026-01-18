"""Embedding endpoint using Google Generative AI"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import hashlib

from app.config import settings

router = APIRouter()

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

@router.post("/ai/embed", response_model=EmbedResponse)
async def get_embedding(request: EmbedRequest):
    """Generate embedding for text using Google Generative AI"""
    
    if not request.text or len(request.text.strip()) < 10:
        raise HTTPException(status_code=400, detail="Text too short for embedding")
    
    # Check cache first
    cache_key = get_cache_key(request.text[:8000])
    if cache_key in embedding_cache:
        return EmbedResponse(embedding=embedding_cache[cache_key], cached=True)
    
    try:
        import google.generativeai as genai
        
        genai.configure(api_key=settings.GOOGLE_API_KEY)
        
        # Use text-embedding-004 model
        result = genai.embed_content(
            model="models/text-embedding-004",
            content=request.text[:8000],  # Limit text length
            task_type="retrieval_document"
        )
        
        embedding = result['embedding']
        
        # Cache the result
        if len(embedding_cache) < MAX_CACHE_SIZE:
            embedding_cache[cache_key] = embedding
        
        return EmbedResponse(embedding=embedding, cached=False)
        
    except Exception as e:
        print(f"❌ Embedding error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Embedding failed: {str(e)}")

"""SerpAPI proxy endpoint - ported from Node.js backend"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import httpx

from app.config import settings

router = APIRouter()


class SerpSearchRequest(BaseModel):
    q: str


@router.post("/serp/search")
async def serp_search(request: SerpSearchRequest):
    """Proxy search request to SerpAPI"""
    
    if not request.q or not isinstance(request.q, str):
        raise HTTPException(status_code=400, detail="Missing query 'q'")
    
    if not settings.SERP_API_KEY:
        raise HTTPException(status_code=400, detail="SERP_API_KEY not configured on server")
    
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                "https://serpapi.com/search.json",
                params={
                    "engine": "google",
                    "q": request.q,
                    "api_key": settings.SERP_API_KEY,
                    "num": "10"
                }
            )
            
            if response.status_code != 200:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"SerpAPI error: {response.text[:500]}"
                )
            
            return response.json()
            
    except httpx.TimeoutException:
        raise HTTPException(status_code=408, detail="SerpAPI request timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

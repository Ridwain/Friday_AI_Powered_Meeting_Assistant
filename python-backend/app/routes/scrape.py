"""Web scraping endpoints - ported from Node.js backend"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import httpx
from bs4 import BeautifulSoup
import hashlib
import re

from app.config import settings

router = APIRouter()


class ScrapeRequest(BaseModel):
    url: str


class ScrapeAndUpsertRequest(BaseModel):
    url: str
    namespaceHint: Optional[str] = None


def clean_text(html: str) -> tuple[str, str]:
    """Extract clean text and title from HTML"""
    soup = BeautifulSoup(html, 'html.parser')
    
    # Remove script and style elements
    for element in soup(['script', 'style', 'nav', 'footer', 'header', 'aside']):
        element.decompose()
    
    # Get title
    title = soup.title.string if soup.title else ""
    
    # Try to find main content
    main_content = soup.find('main') or soup.find('article') or soup.find('body')
    
    if main_content:
        text = main_content.get_text(separator=' ', strip=True)
    else:
        text = soup.get_text(separator=' ', strip=True)
    
    # Clean up whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    
    return title, text


def chunk_text(text: str, chunk_size: int = 1400, overlap: int = 100) -> list[str]:
    """Split text into overlapping chunks"""
    chunks = []
    i = 0
    while i < len(text):
        end = min(i + chunk_size, len(text))
        chunks.append(text[i:end])
        if end == len(text):
            break
        i = end - overlap
    return chunks


def vector_id_for(url: str, idx: int) -> str:
    """Generate unique vector ID for URL chunk"""
    h = hashlib.sha1(f"{url}#{idx}".encode()).hexdigest()
    return f"web_{h}_{idx}"


@router.post("/scrape-url")
async def scrape_url(request: ScrapeRequest):
    """Scrape a URL and return extracted text"""
    
    if not request.url or not request.url.startswith(('http://', 'https://')):
        raise HTTPException(status_code=400, detail="Invalid URL")
    
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                request.url,
                headers={"User-Agent": "Friday/1.0"},
                follow_redirects=True
            )
            
            if response.status_code != 200:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Failed to fetch URL: {response.status_code}"
                )
            
            html = response.text
            title, text = clean_text(html)
            
            return {
                "title": title or request.url,
                "url": request.url,
                "text": text,
                "length": len(text)
            }
            
    except httpx.TimeoutException:
        raise HTTPException(status_code=408, detail="Request timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Scrape failed: {str(e)}")


@router.post("/scrape-and-upsert")
async def scrape_and_upsert(request: ScrapeAndUpsertRequest):
    """Scrape URL, chunk, embed, and upsert to Pinecone"""
    
    if not request.url or not request.url.startswith(('http://', 'https://')):
        raise HTTPException(status_code=400, detail="Invalid URL")
    
    try:
        import google.generativeai as genai
        from urllib.parse import urlparse
        
        # Fetch and parse
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                request.url,
                headers={"User-Agent": "Friday/1.0"},
                follow_redirects=True
            )
            
            if response.status_code != 200:
                return {"success": False, "upserted": 0, "reason": f"Fetch failed: {response.status_code}"}
            
            html = response.text
            title, full_text = clean_text(html)
            
            if not full_text or len(full_text) < 50:
                return {"success": False, "upserted": 0, "reason": "Empty page"}
        
        # Determine namespace
        hostname = urlparse(request.url).hostname or "unknown"
        namespace = request.namespaceHint or f"web:{hostname}"
        
        # Chunk text
        chunks = chunk_text(full_text, 1400, 100)
        
        # Generate embeddings and prepare vectors
        genai.configure(api_key=settings.GOOGLE_API_KEY)
        vectors = []
        
        for i, chunk in enumerate(chunks):
            # Get embedding
            result = genai.embed_content(
                model="models/text-embedding-004",
                content=chunk[:8000],
                task_type="retrieval_document"
            )
            embedding = result['embedding']
            
            vectors.append({
                "id": vector_id_for(request.url, i),
                "values": embedding,
                "metadata": {
                    "source": "web",
                    "url": request.url,
                    "hostname": hostname,
                    "title": title or request.url,
                    "chunkIndex": i,
                    "content": chunk[:1000],
                    "wordCount": len(chunk.split())
                }
            })
        
        if not vectors:
            return {"success": False, "upserted": 0, "reason": "No vectors generated"}
        
        # Batch upsert to Pinecone
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{settings.PINECONE_INDEX_HOST}/vectors/upsert",
                headers={
                    "Api-Key": settings.PINECONE_API_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "vectors": vectors,
                    "namespace": namespace
                }
            )
            
            if response.status_code != 200:
                raise Exception(f"Pinecone upsert failed: {response.text}")
        
        return {
            "success": True,
            "upserted": len(vectors),
            "namespace": namespace,
            "title": title,
            "url": request.url
        }
        
    except Exception as e:
        print(f"❌ Scrape-and-upsert error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed: {str(e)}")

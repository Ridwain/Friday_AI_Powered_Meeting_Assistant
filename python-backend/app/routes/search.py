"""Vector search and upsert endpoints using Pinecone"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import httpx

from app.config import settings

router = APIRouter()

class SearchRequest(BaseModel):
    queryEmbedding: List[float]
    topK: int = 5
    includeMetadata: bool = True
    namespace: str = "meeting-assistant"

class UpsertRequest(BaseModel):
    namespace: str = "meeting-assistant"
    vectors: List[Dict[str, Any]]

class DeleteRequest(BaseModel):
    ids: List[str]
    namespace: str = ""


def extract_clean_filename(metadata: Dict) -> str:
    """
    Extract a clean filename from metadata.
    Priority: filename > title > name > "Document"
    NEVER returns URLs.
    """
    # Check multiple possible fields
    possible_names = [
        metadata.get("filename"),
        metadata.get("title"),
        metadata.get("name"),
    ]
    
    for name in possible_names:
        if name and isinstance(name, str):
            name = name.strip()
            # Skip if it's a URL
            if name.startswith("http://") or name.startswith("https://"):
                continue
            # Skip if it's "Unknown"
            if name.lower() == "unknown":
                continue
            if name:
                return name
    
    return "Document"

@router.post("/search")
async def search_vectors(request: SearchRequest):
    """Search Pinecone for similar vectors"""
    
    if not request.queryEmbedding or not isinstance(request.queryEmbedding, list):
        raise HTTPException(status_code=400, detail="Invalid query embedding")
    
    print(f"🔍 Performing semantic search (topK: {request.topK})...")
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{settings.PINECONE_INDEX_HOST}/query",
                headers={
                    "Api-Key": settings.PINECONE_API_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "vector": request.queryEmbedding,
                    "topK": request.topK,
                    "includeMetadata": request.includeMetadata,
                    "includeValues": False,
                    "namespace": request.namespace
                },
                timeout=20.0
            )
            
            if response.status_code != 200:
                raise Exception(f"Pinecone error: {response.text}")
            
            data = response.json()
            matches = data.get("matches", [])
            
            print(f"✅ Found {len(matches)} matches")
            
            # Transform results
            results = []
            for match in matches:
                meta = match.get("metadata", {})
                
                # Extract clean filename - NEVER return URLs
                filename = extract_clean_filename(meta)
                
                results.append({
                    "id": match.get("id", ""),
                    "score": match.get("score", 0),
                    "filename": filename,
                    "chunkIndex": meta.get("chunkIndex", 0),
                    "content": meta.get("content", ""),
                    "metadata": meta
                })
            
            return results
            
    except Exception as e:
        print(f"❌ Search error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


@router.post("/upsert")
async def upsert_vectors(request: UpsertRequest):
    """Upsert vectors to Pinecone"""
    
    print("📥 Received upsert request")
    print(f"🔍 Namespace: {request.namespace}")
    print(f"📦 Number of vectors: {len(request.vectors)}")
    
    if not request.vectors:
        raise HTTPException(status_code=400, detail="No vectors provided")
    
    try:
        async with httpx.AsyncClient() as client:
            # Format vectors for Pinecone
            formatted_vectors = [{
                "id": v.get("id"),
                "values": v.get("values"),
                "metadata": v.get("metadata", {})
            } for v in request.vectors]
            
            print(f"📤 Upserting {len(formatted_vectors)} vectors to Pinecone...")
            
            response = await client.post(
                f"{settings.PINECONE_INDEX_HOST}/vectors/upsert",
                headers={
                    "Api-Key": settings.PINECONE_API_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "vectors": formatted_vectors,
                    "namespace": request.namespace
                },
                timeout=30.0
            )
            
            if response.status_code != 200:
                raise Exception(f"Pinecone error: {response.text}")
            
            result = response.json()
            
            print(f"✅ Successfully upserted {len(formatted_vectors)} vectors")
            
            return {
                "success": True,
                "upsertedCount": result.get("upsertedCount", len(formatted_vectors)),
                "message": "Vectors successfully upserted to Pinecone"
            }
            
    except Exception as e:
        print(f"❌ Upsert error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Upsert failed: {str(e)}")


@router.post("/delete")
async def delete_vectors(request: DeleteRequest):
    """Delete vectors from Pinecone"""
    
    if not request.ids:
        raise HTTPException(status_code=400, detail="No IDs provided")
    
    print(f"🗑️ Deleting {len(request.ids)} vectors from namespace: {request.namespace}")
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{settings.PINECONE_INDEX_HOST}/vectors/delete",
                headers={
                    "Api-Key": settings.PINECONE_API_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "ids": request.ids,
                    "namespace": request.namespace
                },
                timeout=20.0
            )
            
            if response.status_code != 200:
                raise Exception(f"Pinecone error: {response.text}")
            
            print(f"✅ Deleted {len(request.ids)} vectors")
            
            return {
                "success": True,
                "deletedCount": len(request.ids),
                "message": "Vectors successfully deleted"
            }
            
    except Exception as e:
        print(f"❌ Delete error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Delete failed: {str(e)}")


@router.get("/stats")
async def get_stats():
    """Get Pinecone index statistics"""
    
    print("📊 Fetching Pinecone index statistics...")
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{settings.PINECONE_INDEX_HOST}/describe_index_stats",
                headers={
                    "Api-Key": settings.PINECONE_API_KEY,
                    "Content-Type": "application/json"
                },
                json={},
                timeout=10.0
            )
            
            if response.status_code != 200:
                raise Exception(f"Pinecone error: {response.text}")
            
            return response.json()
            
    except Exception as e:
        print(f"❌ Stats error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Stats failed: {str(e)}")

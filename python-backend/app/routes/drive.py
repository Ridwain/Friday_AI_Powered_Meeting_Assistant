"""Google Drive sync endpoint with recursive loading and incremental indexing"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import httpx
import io
import re
from datetime import datetime

from app.config import settings

router = APIRouter()

DRIVE_API = "https://www.googleapis.com/drive/v3"

# Supported MIME types
SUPPORTED_MIMES = [
    "application/pdf",
    "application/x-pdf", # Some browsers/systems upload as this
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  # .docx
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",  # .xlsx
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",  # .pptx
    "application/vnd.google-apps.document",  # Google Docs
    "application/vnd.google-apps.spreadsheet",  # Google Sheets
    "text/plain",
    "text/markdown",
    "text/csv",
    "image/jpeg",
    "image/png",
    "image/webp",
]

# Export MIME mappings for Google Workspace files
EXPORT_MIMES = {
    "application/vnd.google-apps.document": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "application/pdf",
}


class SyncRequest(BaseModel):
    folderId: str
    accessToken: str
    meetingId: str
    namespace: Optional[str] = None


class SyncResult(BaseModel):
    success: bool
    syncedCount: int
    skippedCount: int
    totalFiles: int
    errors: Optional[List[Dict[str, str]]] = None


async def list_files_recursive(
    folder_id: str, 
    access_token: str, 
    accumulated: List[Dict] = None
) -> List[Dict]:
    """Recursively list all files in a folder and subfolders"""
    if accumulated is None:
        accumulated = []
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        query = f"'{folder_id}' in parents and trashed = false"
        fields = "files(id,name,mimeType,modifiedTime,webViewLink)"
        
        response = await client.get(
            f"{DRIVE_API}/files",
            params={"q": query, "fields": fields},
            headers={"Authorization": f"Bearer {access_token}"}
        )
        
        if response.status_code != 200:
            raise Exception(f"Drive API error: {response.status_code} - {response.text}")
        
        data = response.json()
        files = data.get("files", [])
        
        for file in files:
            if file["mimeType"] == "application/vnd.google-apps.folder":
                # Recurse into subfolder
                await list_files_recursive(file["id"], access_token, accumulated)
            else:
                accumulated.append(file)
    
    return accumulated


async def download_file(file_id: str, mime_type: str, access_token: str) -> bytes:
    """Download file content from Drive, handling Google Workspace exports"""
    async with httpx.AsyncClient(timeout=60.0) as client:
        # Google Workspace files need to be exported
        if mime_type in EXPORT_MIMES:
            export_mime = EXPORT_MIMES[mime_type]
            url = f"{DRIVE_API}/files/{file_id}/export"
            params = {"mimeType": export_mime}
        else:
            url = f"{DRIVE_API}/files/{file_id}"
            params = {"alt": "media"}
        
        response = await client.get(
            url,
            params=params,
            headers={"Authorization": f"Bearer {access_token}"}
        )
        
        if response.status_code != 200:
            raise Exception(f"Download failed: {response.status_code}")
        
        return response.content


async def get_indexed_modified_time(file_id: str, meeting_id: str, namespace: str) -> Optional[str]:
    """Check Pinecone if file is already indexed using fetch API (more reliable than query)"""
    try:
        # Use fetch by ID instead of query with zero vector
        # This is more reliable because query with [0.0]*768 often returns no matches
        vector_id = f"{meeting_id}_{file_id}_0"  # First chunk ID pattern
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.PINECONE_INDEX_HOST}/vectors/fetch",
                params={"ids": vector_id, "namespace": namespace},
                headers={
                    "Api-Key": settings.PINECONE_API_KEY,
                }
            )
            
            if response.status_code == 200:
                data = response.json()
                vectors = data.get("vectors", {})
                if vector_id in vectors:
                    modified_time = vectors[vector_id].get("metadata", {}).get("modified_time")
                    print(f"📋 Found indexed: {file_id} (modified: {modified_time})")
                    return modified_time
                else:
                    print(f"🆕 Not yet indexed: {file_id}")
    except Exception as e:
        print(f"⚠️ Could not check indexed time for {file_id}: {e}")
    
    return None


async def delete_file_vectors(file_id: str, namespace: str):
    """Delete all vectors for a file from Pinecone"""
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            # Delete by filter (file_id)
            response = await client.post(
                f"{settings.PINECONE_INDEX_HOST}/vectors/delete",
                headers={
                    "Api-Key": settings.PINECONE_API_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "namespace": namespace,
                    "filter": {"file_id": {"$eq": file_id}}
                }
            )
            
            if response.status_code == 200:
                print(f"🗑️ Deleted old vectors for file_id: {file_id}")
    except Exception as e:
        print(f"⚠️ Could not delete vectors for {file_id}: {e}")


def is_supported(mime_type: str, filename: str = "") -> bool:
    """Check if file type is supported"""
    if mime_type in SUPPORTED_MIMES:
        return True
    # Fallback for PDFs compliant with binary octet-stream
    if filename.lower().endswith(".pdf"):
        return True
    return False


@router.post("/drive/sync", response_model=SyncResult)
async def sync_drive_folder(request: SyncRequest):
    """
    Sync a Google Drive folder:
    1. Recursively list all files
    2. Check if each file needs re-indexing (incremental)
    3. Download, parse, chunk, embed, and upsert
    """
    from app.routes.parse import parse_content
    from app.routes.embed import get_embedding_internal
    
    print(f"📁 Starting sync for folder {request.folderId}, meeting {request.meetingId}")
    
    namespace = request.namespace or f"meeting:{request.meetingId}"
    synced = 0
    skipped = 0
    errors = []
    
    try:
        # Step 1: Recursively list all files
        all_files = await list_files_recursive(request.folderId, request.accessToken)
        print(f"📄 Found {len(all_files)} files (recursive)")
        
        for file in all_files:
            file_id = file["id"]
            file_name = file["name"]
            mime_type = file["mimeType"]
            modified_time = file.get("modifiedTime", "")
            source_url = file.get("webViewLink", f"https://drive.google.com/file/d/{file_id}")
            
            # Check if supported
            if not is_supported(mime_type, file_name):
                print(f"⏭️ Skipping unsupported: {file_name} ({mime_type})")
                skipped += 1
                continue
            
            try:
                # Step 2: Incremental check
                indexed_time = await get_indexed_modified_time(file_id, request.meetingId, namespace)
                if indexed_time and indexed_time == modified_time:
                    print(f"✅ Already indexed: {file_name}")
                    skipped += 1
                    continue
                
                # If modified, delete old vectors first
                if indexed_time:
                    await delete_file_vectors(file_id, namespace)
                
                # Step 3: Download file
                print(f"⬇️ Downloading: {file_name}")
                content = await download_file(file_id, mime_type, request.accessToken)
                
                if not content or len(content) < 50:
                    print(f"⚠️ File too small: {file_name}")
                    skipped += 1
                    continue
                
                # Step 4: Parse content
                # Determine effective MIME after export
                effective_mime = EXPORT_MIMES.get(mime_type, mime_type)
                
                text, file_metadata = await parse_content(
                    content, 
                    effective_mime, 
                    file_name
                )
                
                if not text or len(text.strip()) < 50:
                    print(f"⚠️ No extractable text: {file_name}")
                    skipped += 1
                    continue
                
                # Step 5: Chunk text
                chunks = chunk_text_smart(text, mime_type, 1000, 200)
                print(f"📦 Created {len(chunks)} chunks for {file_name}")
                
                # Step 6: Generate embeddings and prepare vectors
                vectors = []
                for i, chunk_data in enumerate(chunks):
                    chunk_text_content = chunk_data["text"]
                    chunk_meta = chunk_data.get("metadata", {})
                    
                    # Prepend filename and file type for better searchability
                    # This enables queries like "pptx file এ কি আছে?" or "cpp.txt এ কি লেখা?"
                    file_extension = file_name.split('.')[-1].lower() if '.' in file_name else ''
                    text_for_embedding = f"[File: {file_name}] [Type: {file_extension}] {chunk_text_content}"
                    
                    embedding = await get_embedding_internal(text_for_embedding)
                    if not embedding:
                        continue
                    
                    vectors.append({
                        "id": f"{request.meetingId}_{file_id}_{i}",
                        "values": embedding,
                        "metadata": {
                            "file_id": file_id,
                            "filename": file_name,  # For backward compatibility
                            "title": file_name,
                            "source": source_url,
                            "file_type": mime_type.split("/")[-1].split(".")[-1],
                            "modified_time": modified_time,
                            "chunkIndex": i,
                            "content": chunk_text_content[:1000],
                            **chunk_meta  # page_number, row_index, etc.
                        }
                    })
                
                # Step 7: Batch upsert
                if vectors:
                    await batch_upsert(vectors, namespace)
                    synced += 1
                    print(f"✅ Indexed: {file_name} ({len(vectors)} vectors)")
                else:
                    skipped += 1
                    
            except Exception as file_error:
                print(f"❌ Error processing {file_name}: {str(file_error)}")
                errors.append({"file": file_name, "error": str(file_error)})
                skipped += 1
        
        print(f"✅ Sync complete: {synced} synced, {skipped} skipped")
        
        return SyncResult(
            success=True,
            syncedCount=synced,
            skippedCount=skipped,
            totalFiles=len(all_files),
            errors=errors if errors else None
        )
        
    except Exception as e:
        print(f"❌ Sync error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Sync failed: {str(e)}")


def chunk_text_smart(text: str, mime_type: str, chunk_size: int = 1000, overlap: int = 200) -> List[Dict]:
    """
    Smart chunking based on file type.
    Returns list of {"text": str, "metadata": dict}
    """
    chunks = []
    
    # For Excel/CSV rows, each line is already a logical chunk
    if "spreadsheet" in mime_type or "csv" in mime_type:
        lines = text.strip().split("\n")
        for i, line in enumerate(lines):
            if line.strip():
                chunks.append({
                    "text": line.strip(),
                    "metadata": {"row_index": i}
                })
        return chunks
    
    # For PDFs, try to preserve page boundaries if present
    if "pdf" in mime_type and "[PAGE " in text:
        pages = re.split(r'\[PAGE \d+\]', text)
        for page_num, page_text in enumerate(pages, 1):
            if page_text.strip():
                # Further chunk if page is too long
                page_chunks = recursive_chunk(page_text.strip(), chunk_size, overlap)
                for chunk in page_chunks:
                    chunks.append({
                        "text": chunk,
                        "metadata": {"page_number": page_num}
                    })
        return chunks
    
    # Default: Recursive character splitting
    text_chunks = recursive_chunk(text, chunk_size, overlap)
    for chunk in text_chunks:
        chunks.append({"text": chunk, "metadata": {}})
    
    return chunks


def recursive_chunk(text: str, chunk_size: int = 1000, overlap: int = 200) -> List[str]:
    """Recursive character text splitter"""
    separators = ["\n\n", "\n", ". ", " ", ""]
    
    def split_with_separator(text: str, sep: str) -> List[str]:
        if sep:
            return text.split(sep)
        return list(text)
    
    final_chunks = []
    
    for sep in separators:
        parts = split_with_separator(text, sep)
        
        current_chunk = ""
        for part in parts:
            test_chunk = current_chunk + (sep if current_chunk else "") + part
            
            if len(test_chunk) <= chunk_size:
                current_chunk = test_chunk
            else:
                if current_chunk:
                    final_chunks.append(current_chunk)
                    # Overlap: keep last portion
                    current_chunk = current_chunk[-overlap:] + sep + part if len(current_chunk) > overlap else part
                else:
                    # Part itself is too long, move to next separator
                    if sep != separators[-1]:
                        break
                    final_chunks.append(part[:chunk_size])
                    current_chunk = part[chunk_size - overlap:]
        
        if current_chunk:
            final_chunks.append(current_chunk)
        
        if final_chunks and all(len(c) <= chunk_size for c in final_chunks):
            break
        
        final_chunks = []
    
    # Fallback: simple split
    if not final_chunks:
        i = 0
        while i < len(text):
            end = min(i + chunk_size, len(text))
            final_chunks.append(text[i:end])
            i = end - overlap if end < len(text) else end
    
    return final_chunks


async def batch_upsert(vectors: List[Dict], namespace: str, batch_size: int = 100):
    """Upsert vectors to Pinecone in batches"""
    async with httpx.AsyncClient(timeout=30.0) as client:
        for i in range(0, len(vectors), batch_size):
            batch = vectors[i:i + batch_size]
            
            response = await client.post(
                f"{settings.PINECONE_INDEX_HOST}/vectors/upsert",
                headers={
                    "Api-Key": settings.PINECONE_API_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "vectors": batch,
                    "namespace": namespace
                }
            )
            
            if response.status_code != 200:
                raise Exception(f"Pinecone upsert failed: {response.text}")
            
            print(f"📤 Upserted batch {i//batch_size + 1}: {len(batch)} vectors")

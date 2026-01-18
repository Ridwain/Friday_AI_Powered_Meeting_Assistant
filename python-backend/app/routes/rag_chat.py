"""
RAG Chat endpoint using LangChain ConversationalRetrievalChain
Combines memory + document retrieval automatically
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Optional
import json

router = APIRouter()

class RAGChatRequest(BaseModel):
    query: str
    session_id: str
    namespace: str = "documents"
    meeting_id: Optional[str] = None

class RAGChatResponse(BaseModel):
    answer: str
    sources: List[Dict]
    session_id: str


@router.post("/chat", response_model=RAGChatResponse)
async def rag_chat(request: RAGChatRequest):
    """
    Chat with documents using LangChain RAG + Memory
    Automatically retrieves relevant context and maintains conversation history
    """
    try:
        from app.chains.advanced_rag import query_with_advanced_memory
        
        # Determine namespace
        namespace = request.namespace
        if request.meeting_id:
            namespace = f"meeting:{request.meeting_id}"
        
        result = await query_with_advanced_memory(
            query=request.query,
            session_id=request.session_id,
            namespace=namespace
        )
        
        return RAGChatResponse(
            answer=result["answer"],
            sources=result["sources"],
            session_id=result["session_id"]
        )
        
    except Exception as e:
        print(f"❌ RAG Chat error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat/stream")
async def rag_chat_stream(request: RAGChatRequest):
    """
    Stream RAG chat response with memory
    """
    async def generate():
        try:
            from app.chains.rag_chain import get_rag_chain
            
            # Determine namespace
            namespace = request.namespace
            if request.meeting_id:
                namespace = f"meeting:{request.meeting_id}"
            
            chain = get_rag_chain(request.session_id, namespace)
            
            # Stream response
            async for chunk in chain.astream({"question": request.query}):
                if "answer" in chunk:
                    data = json.dumps({
                        "choices": [{
                            "delta": {"content": chunk["answer"]},
                            "finish_reason": None
                        }]
                    })
                    yield f"data: {data}\n\n"
            
            yield "data: [DONE]\n\n"
            
        except Exception as e:
            print(f"❌ Stream error: {str(e)}")
            error_data = json.dumps({"error": str(e)})
            yield f"data: {error_data}\n\n"
            yield "data: [DONE]\n\n"
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        }
    )


@router.get("/chat/history/{session_id}")
async def get_chat_history(session_id: str):
    """Get conversation history for a session"""
    try:
        from app.chains.rag_chain import get_session_history
        
        history = get_session_history(session_id)
        return {
            "session_id": session_id,
            "messages": history,
            "count": len(history)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/chat/history/{session_id}")
async def clear_chat_history(session_id: str):
    """Clear conversation history for a session"""
    try:
        from app.chains.chain_utils import clear_session_memory
        
        cleared = clear_session_memory(session_id)
        return {
            "success": cleared,
            "message": f"Memory {'cleared' if cleared else 'not found'} for session {session_id}"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/chat/sessions")
async def list_sessions():
    """List all active chat sessions"""
    try:
        from app.chains.rag_chain import get_all_sessions
        
        sessions = get_all_sessions()
        return {
            "sessions": sessions,
            "count": len(sessions)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

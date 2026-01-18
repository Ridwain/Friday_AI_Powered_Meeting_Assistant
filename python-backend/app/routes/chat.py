"""Chat streaming endpoint with LangChain memory"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import json

from app.config import settings

router = APIRouter()

# Store conversation memories per session
conversation_memories: Dict[str, List[Dict[str, str]]] = {}
MAX_MEMORY_MESSAGES = 20

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[Message]
    model: str = "gemini-2.5-flash-lite"
    temperature: float = 0.7
    max_tokens: int = 4096
    stream: bool = True
    session_id: Optional[str] = None

@router.post("/ai/stream")
async def chat_stream(request: ChatRequest):
    """Stream chat completion using Google Generative AI"""
    
    if not request.messages:
        raise HTTPException(status_code=400, detail="No messages provided")
    
    # Update session memory if session_id provided
    if request.session_id:
        if request.session_id not in conversation_memories:
            conversation_memories[request.session_id] = []
        
        # Add new messages to memory (keep last N)
        for msg in request.messages:
            conversation_memories[request.session_id].append({
                "role": msg.role,
                "content": msg.content
            })
        
        # Trim memory
        if len(conversation_memories[request.session_id]) > MAX_MEMORY_MESSAGES:
            conversation_memories[request.session_id] = conversation_memories[request.session_id][-MAX_MEMORY_MESSAGES:]
    
    async def generate():
        """Generate streaming response"""
        try:
            import google.generativeai as genai
            
            genai.configure(api_key=settings.GOOGLE_API_KEY)
            
            # Map model name
            model_name = request.model
            if "gemini" not in model_name.lower():
                model_name = "gemini-2.0-flash"
            
            model = genai.GenerativeModel(model_name)
            
            # Convert messages to Gemini format
            gemini_messages = []
            system_instruction = None
            
            for msg in request.messages:
                if msg.role == "system":
                    system_instruction = msg.content
                elif msg.role == "user":
                    gemini_messages.append({"role": "user", "parts": [msg.content]})
                elif msg.role == "assistant":
                    gemini_messages.append({"role": "model", "parts": [msg.content]})
            
            # Create chat with history
            chat = model.start_chat(history=gemini_messages[:-1] if len(gemini_messages) > 1 else [])
            
            # Get the last user message
            last_message = next(
                (msg.content for msg in reversed(request.messages) if msg.role == "user"),
                ""
            )
            
            # Add system instruction to the message if present
            if system_instruction:
                last_message = f"{system_instruction}\n\n{last_message}"
            
            # Stream response
            response = chat.send_message(
                last_message,
                generation_config=genai.types.GenerationConfig(
                    temperature=request.temperature,
                    max_output_tokens=request.max_tokens,
                ),
                stream=True
            )
            
            for chunk in response:
                if chunk.text:
                    # Format as SSE in Gemini-compatible format (frontend expects this)
                    data = json.dumps({
                        "candidates": [{
                            "content": {
                                "parts": [{"text": chunk.text}]
                            }
                        }]
                    })
                    yield f"data: {data}\n\n"
            
            # Send done signal
            yield "data: [DONE]\n\n"
            
        except Exception as e:
            print(f"❌ Chat error: {str(e)}")
            error_data = json.dumps({"error": str(e)})
            yield f"data: {error_data}\n\n"
            yield "data: [DONE]\n\n"
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@router.get("/memory/{session_id}")
async def get_memory(session_id: str):
    """Get conversation memory for a session"""
    return {
        "session_id": session_id,
        "messages": conversation_memories.get(session_id, []),
        "count": len(conversation_memories.get(session_id, []))
    }


@router.delete("/memory/{session_id}")
async def clear_memory(session_id: str):
    """Clear conversation memory for a session"""
    if session_id in conversation_memories:
        del conversation_memories[session_id]
    return {"success": True, "message": f"Memory cleared for session {session_id}"}

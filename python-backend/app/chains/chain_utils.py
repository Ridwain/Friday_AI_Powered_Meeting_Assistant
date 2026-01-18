from typing import Dict, List, Any
from langchain.memory import ConversationBufferWindowMemory
from langchain.prompts import PromptTemplate
from langchain.chains import ConversationalRetrievalChain

# Store session memories and chains
session_memories: Dict[str, ConversationBufferWindowMemory] = {}
session_chains: Dict[str, ConversationalRetrievalChain] = {}

# Custom prompt for better synthesis
QA_PROMPT = PromptTemplate.from_template("""You are a helpful AI assistant. Use the following pieces of context from the user's documents to answer the question. 
If you don't know the answer based on the context, just say that you don't have that information in your documents.

IMPORTANT INSTRUCTIONS:
- Synthesize a clear, concise answer in your own words
- Do NOT copy-paste large chunks of text verbatim
- Summarize and explain the key points naturally
- Be conversational and helpful
- At the end, briefly mention which document(s) the information came from

Context from documents:
{context}

Question: {question}

Answer:""")

def get_memory(session_id: str) -> ConversationBufferWindowMemory:
    """Get or create memory for a session"""
    if session_id not in session_memories:
        session_memories[session_id] = ConversationBufferWindowMemory(
            memory_key="chat_history",
            return_messages=True,
            output_key="answer",
            k=10  # Keep last 10 conversation turns
        )
    return session_memories[session_id]

def clear_session_memory(session_id: str) -> bool:
    """Clear memory for a specific session"""
    cleared = False
    
    if session_id in session_memories:
        session_memories[session_id].clear()
        del session_memories[session_id]
        cleared = True
    
    # Also clear cached chains
    keys_to_remove = [k for k in session_chains.keys() if k.startswith(f"{session_id}:")]
    for key in keys_to_remove:
        del session_chains[key]
    
    return cleared

def get_session_history(session_id: str) -> List[Dict[str, str]]:
    """Get conversation history for a session"""
    if session_id in session_memories:
        memory = session_memories[session_id]
        messages = memory.chat_memory.messages
        return [
            {
                "role": "user" if msg.type == "human" else "assistant",
                "content": msg.content
            }
            for msg in messages
        ]
    return []

def get_all_sessions() -> List[str]:
    """Get list of all active session IDs"""
    return list(session_memories.keys())

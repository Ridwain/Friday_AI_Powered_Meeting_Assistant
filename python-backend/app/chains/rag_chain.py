"""
LangChain RAG Chain with Conversation Memory
Using official langchain-pinecone package
"""

from typing import Dict, List, Optional, Any
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from langchain_pinecone import PineconeVectorStore
from langchain.chains import ConversationalRetrievalChain
from langchain.memory import ConversationBufferWindowMemory
from langchain.prompts import PromptTemplate

from app.config import settings

# Initialize LLM
llm = ChatGoogleGenerativeAI(
    model="gemini-2.5-flash-lite",
    google_api_key=settings.GOOGLE_API_KEY,
    temperature=0.7,
    streaming=True
)

# Initialize embeddings
embeddings = GoogleGenerativeAIEmbeddings(
    model="models/gemini-embedding-001",
    google_api_key=settings.GOOGLE_API_KEY,
    task_type="retrieval_document",
    output_dimensionality=768
)

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


def get_vectorstore(namespace: str) -> PineconeVectorStore:
    """Get Pinecone vector store for a namespace using official package"""
    return PineconeVectorStore(
        index_name=settings.PINECONE_INDEX_NAME,
        embedding=embeddings,
        namespace=namespace,
        pinecone_api_key=settings.PINECONE_API_KEY,
        text_key="content"  # Metadata key where text is stored
    )


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


def get_rag_chain(session_id: str, namespace: str = "documents") -> ConversationalRetrievalChain:
    """Get or create RAG chain for a session with memory"""
    
    chain_key = f"{session_id}:{namespace}"
    
    # Reuse existing chain if same namespace
    if chain_key in session_chains:
        return session_chains[chain_key]
    
    # Create vectorstore and retriever using official langchain-pinecone
    vectorstore = get_vectorstore(namespace)
    retriever = vectorstore.as_retriever(
        search_type="similarity",
        search_kwargs={"k": 5}
    )
    
    memory = get_memory(session_id)
    
    chain = ConversationalRetrievalChain.from_llm(
        llm=llm,
        retriever=retriever,
        memory=memory,
        return_source_documents=True,
        combine_docs_chain_kwargs={"prompt": QA_PROMPT},
        verbose=False
    )
    
    session_chains[chain_key] = chain
    return chain


async def query_with_memory(
    query: str,
    session_id: str,
    namespace: str = "documents"
) -> Dict[str, Any]:
    """
    Query documents with conversation memory
    Returns answer and source documents
    """
    chain = get_rag_chain(session_id, namespace)
    
    # Run the chain
    result = chain.invoke({"question": query})
    
    # Extract source documents
    sources = []
    if "source_documents" in result:
        for doc in result["source_documents"]:
            sources.append({
                "content": doc.page_content[:500],
                "metadata": doc.metadata
            })
    
    return {
        "answer": result.get("answer", ""),
        "sources": sources,
        "session_id": session_id
    }


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

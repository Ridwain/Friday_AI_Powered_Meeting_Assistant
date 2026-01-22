"""
Advanced RAG Chain using FlashRank and Multi-Query Retrieval
- Multi-Query: Expands query to increase recall
- FlashRank: Re-ranks documents using cross-encoder for precision
"""

from typing import Dict, Any, List
import logging
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from langchain_pinecone import PineconeVectorStore
from langchain.retrievers import ContextualCompressionRetriever
from langchain.retrievers.multi_query import MultiQueryRetriever
from langchain_community.document_compressors.flashrank_rerank import FlashrankRerank
from langchain.chains import ConversationalRetrievalChain
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import BaseOutputParser

from app.config import settings
from app.chains.chain_utils import get_memory, QA_PROMPT, session_chains, session_memories

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class LineListOutputParser(BaseOutputParser[List[str]]):
    """Output parser for a list of lines."""
    def parse(self, text: str) -> List[str]:
        lines = text.strip().split("\n")
        return [line.strip() for line in lines if line.strip()]

def get_advanced_retriever(namespace: str):
    """
    Creates an advanced retriever pipeline:
    1. Multi-Query Retriever (Expansion) -> Gets ~10 docs
    2. FlashRank Reranker (Compression) -> Selects Top 5
    """
    # Initialize fresh embeddings for this request to avoid closed session issues
    embeddings = GoogleGenerativeAIEmbeddings(
        model="models/text-embedding-004",
        google_api_key=settings.GOOGLE_API_KEY
    )
    
    # Initialize fresh vectorstore
    vectorstore = PineconeVectorStore(
        index_name=settings.PINECONE_INDEX_NAME,
        embedding=embeddings,
        namespace=namespace,
        pinecone_api_key=settings.PINECONE_API_KEY,
        text_key="content"
    )
    
    base_retriever = vectorstore.as_retriever(
        search_type="similarity",
        search_kwargs={"k": 10}  # Fetch more docs initially for Reranking
    )
    
    # Initialize fresh LLM
    local_llm = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash-lite",
        google_api_key=settings.GOOGLE_API_KEY,
        temperature=0.7,
        streaming=True
    )
    
    # 1. Multi-Query Retriever (Query Expansion)
    QUERY_PROMPT = PromptTemplate(
        input_variables=["question"],
        template="""You are an AI language model assistant. Your task is to generate 
        3 different versions of the given user question to retrieve relevant documents from a vector database. 
        By generating multiple perspectives on the user question, your goal is to help the user overcome some of the limitations 
        of distance-based similarity search. 
        
        IMPORTANT: If the user asks in a different language (e.g. Bengali), translate it to English for the search queries.
        Also, think about synonyms (e.g. "birthday" -> "born on", "cost" -> "price").
        
        Provide these alternative questions separated by newlines.
        Original question: {question}"""
    )
    
    multi_query_retriever = MultiQueryRetriever.from_llm(
        retriever=base_retriever,
        llm=local_llm,
        prompt=QUERY_PROMPT,
        parser_key="lines",
        include_original=True
    )
    
    # 2. FlashRank Reranker (Contextual Compression)
    compressor = FlashrankRerank(
        model="ms-marco-TinyBERT-L-2-v2", 
        top_n=5
    )
    
    compression_retriever = ContextualCompressionRetriever(
        base_compressor=compressor,
        base_retriever=multi_query_retriever
    )
    
    return compression_retriever

def get_advanced_rag_chain(session_id: str, namespace: str = "documents") -> ConversationalRetrievalChain:
    """Get or create Advanced RAG chain for a session"""
    
    # Note: We don't cache chains here anymore because we want fresh sessions per request
    # Since we are re-initing components, we'll build a fresh chain.
    # But we CAN cache memory.
    
    logger.info(f"🚀 Initializing Advanced RAG Chain for session: {session_id}")
    
    retriever = get_advanced_retriever(namespace)
    memory = get_memory(session_id)
    
    # Initialize fresh LLM for QA
    # Initialize fresh LLM for QA
    qa_llm = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash-lite",
        google_api_key=settings.GOOGLE_API_KEY,
        temperature=0.7,
        streaming=True
    )
    
    chain = ConversationalRetrievalChain.from_llm(
        llm=qa_llm,
        retriever=retriever,
        memory=memory,
        return_source_documents=True,
        combine_docs_chain_kwargs={"prompt": QA_PROMPT},
        verbose=True
    )
    
    return chain


import asyncio
from concurrent.futures import ThreadPoolExecutor

executor = ThreadPoolExecutor(max_workers=5)

async def query_with_advanced_memory(
    query: str,
    session_id: str,
    namespace: str = "documents"
) -> Dict[str, Any]:
    """
    Query documents using Advanced RAG (Multi-Query + FlashRank)
    Uses synchronous chain execution in a thread pool to avoid async session issues.
    """
    
    def run_sync_chain():
        # Initialize chain inside the thread to ensure thread-local safety if needed
        chain = get_advanced_rag_chain(session_id, namespace)
        return chain.invoke({"question": query})

    loop = asyncio.get_running_loop()
    # Run the synchronous chain.invoke in a thread pool
    result = await loop.run_in_executor(executor, run_sync_chain)
    
    # Extract source documents with type sanitization
    sources = []
    if "source_documents" in result:
        print(f"📄 Top {len(result['source_documents'])} Chunks for: '{query}'")
        for i, doc in enumerate(result["source_documents"]):
            # Sanitize metadata to remove numpy types and cleanup filenames
            metadata = {}
            for k, v in doc.metadata.items():
                if hasattr(v, 'item'):
                     metadata[k] = v.item()
                else:
                     metadata[k] = v
            
            # Force clean filename (no URLs)
            clean_name = "Document"
            possible_names = [
                metadata.get('filename'),
                metadata.get('title'),
                metadata.get('name')
            ]
            
            for name in possible_names:
                if name and isinstance(name, str):
                    name_str = name.strip()
                    if name_str and not name_str.startswith('http') and name_str.lower() != 'unknown':
                        clean_name = name_str
                        break
            
            # Ensure filename is set to the clean name
            metadata['filename'] = clean_name
            
            # Remove source if it is a URL to prevent frontend fallback from using it
            if metadata.get('source', '').startswith('http'):
                metadata['source'] = clean_name
            
            print(f"[{i}] {metadata.get('filename')} (Content: {doc.page_content[:100]}...)")
            
            sources.append({
                "content": doc.page_content,
                "metadata": metadata
            })
    
    return {
        "answer": result.get("answer", ""),
        "sources": sources,
        "session_id": session_id
    }

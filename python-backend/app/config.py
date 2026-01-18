from pydantic_settings import BaseSettings
from typing import List, Optional
import os

class Settings(BaseSettings):
    # API Keys
    GOOGLE_API_KEY: str = ""
    PINECONE_API_KEY: str = ""
    PINECONE_INDEX_HOST: str = ""
    PINECONE_INDEX_NAME: str = "siat"
    SERP_API_KEY: str = ""
    
    # Server
    PORT: int = 3001
    ALLOW_ALL_EXTENSIONS: bool = True
    
    # CORS
    CORS_ORIGINS: List[str] = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
        "https://friday-e65f2.web.app",
        "https://friday-e65f2.firebaseapp.com",
    ]
    
    class Config:
        env_file = ".env"
        extra = "allow"

settings = Settings()

# Validate required settings
def validate_settings():
    missing = []
    if not settings.GOOGLE_API_KEY:
        missing.append("GOOGLE_API_KEY")
    if not settings.PINECONE_API_KEY:
        missing.append("PINECONE_API_KEY")
    if not settings.PINECONE_INDEX_HOST:
        missing.append("PINECONE_INDEX_HOST")
    
    if missing:
        print(f"⚠️ Missing environment variables: {', '.join(missing)}")
    else:
        print("✅ All required environment variables are set")

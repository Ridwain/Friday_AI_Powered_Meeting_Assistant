"""
OAuth Routes - Authorization Code Flow with PKCE
Exchanges authorization codes for access tokens securely
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import httpx

from app.config import settings

router = APIRouter(prefix="/oauth", tags=["OAuth"])


class TokenExchangeRequest(BaseModel):
    """Request body for token exchange"""
    code: str
    code_verifier: str
    redirect_uri: str


class TokenResponse(BaseModel):
    """Response with access token"""
    access_token: str
    token_type: str
    expires_in: int
    scope: str


@router.post("/exchange", response_model=TokenResponse)
async def exchange_code_for_token(request: TokenExchangeRequest):
    """
    Exchange authorization code for access token using PKCE.
    
    This endpoint receives the authorization code from the frontend,
    validates it with Google's token endpoint, and returns the access token.
    The code_verifier is used by Google to verify the PKCE challenge.
    """
    
    if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
        raise HTTPException(
            status_code=500,
            detail="OAuth credentials not configured on server"
        )
    
    # Google's token endpoint
    token_url = "https://oauth2.googleapis.com/token"
    
    # Prepare the token exchange request
    token_data = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "client_secret": settings.GOOGLE_CLIENT_SECRET,
        "code": request.code,
        "code_verifier": request.code_verifier,
        "grant_type": "authorization_code",
        "redirect_uri": request.redirect_uri,
    }
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(token_url, data=token_data)
            
            if response.status_code != 200:
                error_data = response.json()
                print(f"❌ Token exchange failed: {error_data}")
                raise HTTPException(
                    status_code=400,
                    detail=f"Token exchange failed: {error_data.get('error_description', error_data.get('error', 'Unknown error'))}"
                )
            
            token_response = response.json()
            
            print(f"✅ Token exchange successful, scope: {token_response.get('scope', 'N/A')}")
            
            return TokenResponse(
                access_token=token_response["access_token"],
                token_type=token_response.get("token_type", "Bearer"),
                expires_in=token_response.get("expires_in", 3600),
                scope=token_response.get("scope", "")
            )
            
    except httpx.RequestError as e:
        print(f"❌ Network error during token exchange: {e}")
        raise HTTPException(
            status_code=502,
            detail="Failed to connect to Google OAuth server"
        )

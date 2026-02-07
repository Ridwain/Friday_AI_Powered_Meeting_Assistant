"""
OAuth Routes - Authorization Code Flow with PKCE
Exchanges authorization codes for access tokens securely
"""

from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
import httpx

from app.config import settings

router = APIRouter(prefix="/oauth", tags=["OAuth"])

# ============================================
# Temporary Store for OAuth State
# In production, use Redis with TTL
# ============================================
oauth_pending_store: dict[str, dict] = {}

def cleanup_expired_states():
    """Remove states older than 10 minutes"""
    cutoff = datetime.now() - timedelta(minutes=10)
    expired = [k for k, v in oauth_pending_store.items() if v.get("created_at", datetime.now()) < cutoff]
    for k in expired:
        oauth_pending_store.pop(k, None)


# ============================================
# Models
# ============================================

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


class OAuthInitRequest(BaseModel):
    """Request body for OAuth initialization"""
    state: str
    code_verifier: str
    frontend_redirect: str


# ============================================
# Endpoints
# ============================================

@router.post("/init")
async def oauth_init(request: OAuthInitRequest):
    """
    Store OAuth state and code_verifier before redirecting to Google.
    Called by frontend before initiating the OAuth flow.
    """
    # Cleanup old states
    cleanup_expired_states()
    
    # Store the state and verifier
    oauth_pending_store[request.state] = {
        "code_verifier": request.code_verifier,
        "frontend_redirect": request.frontend_redirect,
        "created_at": datetime.now()
    }
    
    print(f"✅ OAuth init: stored state {request.state[:8]}...")
    return {"status": "ok"}


@router.get("/callback")
async def oauth_callback(
    code: str = Query(..., description="Authorization code from Google"),
    state: str = Query(..., description="State parameter for CSRF validation")
):
    """
    Handle OAuth callback from Google.
    Exchanges code for token and redirects to frontend with token.
    """
    # 1. Retrieve and validate stored state
    pending = oauth_pending_store.pop(state, None)
    
    if not pending:
        print(f"❌ OAuth callback: invalid or expired state {state[:8]}...")
        error_url = f"{settings.FRONTEND_URL}/dashboard.html?error=invalid_state"
        return RedirectResponse(url=error_url)
    
    code_verifier = pending["code_verifier"]
    frontend_redirect = pending["frontend_redirect"]
    
    print(f"✅ OAuth callback: valid state, exchanging code...")
    
    # 2. Exchange code for token
    if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
        error_url = f"{frontend_redirect}?error=server_config_error"
        return RedirectResponse(url=error_url)
    
    token_url = "https://oauth2.googleapis.com/token"
    
    token_data = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "client_secret": settings.GOOGLE_CLIENT_SECRET,
        "code": code,
        "code_verifier": code_verifier,
        "grant_type": "authorization_code",
        "redirect_uri": f"{settings.BACKEND_URL}/oauth/callback",
    }
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(token_url, data=token_data)
            
            if response.status_code != 200:
                error_data = response.json()
                print(f"❌ Token exchange failed: {error_data}")
                error_url = f"{frontend_redirect}?error=token_exchange_failed"
                return RedirectResponse(url=error_url)
            
            token_response = response.json()
            access_token = token_response["access_token"]
            expires_in = token_response.get("expires_in", 3600)
            
            print(f"✅ Token exchange successful, redirecting to frontend...")
            
            # 3. Redirect to frontend with token
            # Note: For better security, consider using a short-lived code
            # that frontend exchanges for token, rather than putting token in URL
            redirect_url = f"{frontend_redirect}?access_token={access_token}&expires_in={expires_in}"
            return RedirectResponse(url=redirect_url)
            
    except httpx.RequestError as e:
        print(f"❌ Network error during token exchange: {e}")
        error_url = f"{frontend_redirect}?error=network_error"
        return RedirectResponse(url=error_url)


@router.post("/exchange", response_model=TokenResponse)
async def exchange_code_for_token(request: TokenExchangeRequest):
    """
    Exchange authorization code for access token using PKCE.
    
    This endpoint receives the authorization code from the frontend,
    validates it with Google's token endpoint, and returns the access token.
    The code_verifier is used by Google to verify the PKCE challenge.
    
    Note: This endpoint is kept for backward compatibility with popup flow.
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

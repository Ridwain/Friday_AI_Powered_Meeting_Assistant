// ai-chat/drive-service.js
// Google Drive file sync - delegates to Python backend for processing

import { CONFIG } from "./config.js";
import * as storageService from "./storage-service.js";

// ============================================
// OAuth Token
// ============================================

/**
 * Get Google OAuth access token using Chrome identity API
 * Requests Drive scope incrementally (only when this function is called)
 */
export async function getAccessToken() {
    return new Promise((resolve, reject) => {
        // Request token (scopes are now handled by manifest)
        chrome.identity.getAuthToken({
            interactive: true
        }, (token) => {
            if (chrome.runtime.lastError) {
                const errorMsg = chrome.runtime.lastError.message;
                console.error("OAuth error:", errorMsg);

                // Handle user denial gracefully
                if (errorMsg.includes('canceled') || errorMsg.includes('denied')) {
                    reject(new Error('Drive access was not granted. Please login again to grant permissions.'));
                } else {
                    reject(new Error(errorMsg));
                }
            } else if (!token) {
                reject(new Error("No token received"));
            } else {
                console.log("✅ Got OAuth token for Drive access");
                resolve(token);
            }
        });
    });
}


// ============================================
// Folder ID Extraction
// ============================================

/**
 * Extract folder ID from Drive URL
 */
export function extractFolderId(driveUrl) {
    if (!driveUrl) return null;

    const patterns = [
        /folders\/([a-zA-Z0-9_-]+)/,
        /id=([a-zA-Z0-9_-]+)/,
        /\/d\/([a-zA-Z0-9_-]+)/,
    ];

    for (const pattern of patterns) {
        const match = driveUrl.match(pattern);
        if (match) return match[1];
    }

    return null;
}

// ============================================
// Backend-Delegated Sync
// ============================================

let syncInProgress = false;

/**
 * Sync files from a Drive folder - delegates to Python backend
 * Backend handles: Recursive loading, incremental sync, parsing, embedding, upserting
 */
export async function syncMeetingFiles(meeting, onProgress) {
    if (syncInProgress) {
        console.log("⏳ Sync is currently running. Please wait for the '✅ [FRIDAY AI] Auto-sync COMPLETE' message.");
        return { synced: 0, skipped: 0 };
    }

    const folderId = extractFolderId(meeting.driveFolderLink);
    if (!folderId) {
        console.log("⚠️ No Drive folder linked to meeting");
        return { synced: 0, skipped: 0, error: "No folder linked" };
    }

    syncInProgress = true;

    try {
        // Attempt 1: Get token and sync
        onProgress?.("Authenticating...");
        let accessToken = await getAccessToken();

        onProgress?.("Syncing files (processing on server)...");
        console.log(`📁 Calling /drive/sync for folder ${folderId}`);

        let response = await fetch(`${CONFIG.SERVER_URL}/drive/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                folderId,
                accessToken,
                meetingId: meeting.meetingId,
                namespace: CONFIG.NAMESPACES.getMeetingNs(meeting.meetingId)
            })
        });

        // Retry Logic: If 401/403 or sync failed, refresh token and retry ONCE
        let shouldRetry = !response.ok && (response.status === 401 || response.status === 403 || response.status === 500);

        if (shouldRetry) {
            console.log("⚠️ Sync failed or auth error - Retrying with fresh token...");
            onProgress?.("Refreshing session...");

            // Invalidate cached token
            await new Promise(resolve =>
                chrome.identity.removeCachedAuthToken({ token: accessToken }, resolve)
            );

            // Get fresh token
            accessToken = await getAccessToken();

            // Retry sync request
            response = await fetch(`${CONFIG.SERVER_URL}/drive/sync`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    folderId,
                    accessToken,
                    meetingId: meeting.meetingId,
                    namespace: CONFIG.NAMESPACES.getMeetingNs(meeting.meetingId)
                })
            });
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Sync failed: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        console.log(`✅ Sync complete: ${result.syncedCount} synced, ${result.skippedCount} skipped`);

        return {
            synced: result.syncedCount,
            skipped: result.skippedCount,
            total: result.totalFiles,
            errors: result.errors
        };

    } catch (error) {
        console.error("Sync error:", error);
        return { synced: 0, skipped: 0, error: error.message };
    } finally {
        syncInProgress = false;
    }
}

/**
 * Get sync status
 */
export function getSyncStatus() {
    return { inProgress: syncInProgress };
}

/**
 * Auto-sync on meeting open - runs automatically when chat opens
 * Delegates to Python backend for all processing
 */
export async function autoSync(meeting, options = {}) {
    const { silent = true, onProgress } = options;

    if (!meeting?.driveFolderLink) {
        if (!silent) console.log("⚠️ No Drive folder linked");
        return { synced: 0, skipped: 0, noFolder: true };
    }

    const folderId = extractFolderId(meeting.driveFolderLink);
    if (!folderId) return { synced: 0, skipped: 0, error: "Invalid folder URL" };

    console.log("🔄 Auto-sync: Starting server-side sync...");

    try {
        const result = await syncMeetingFiles(meeting, onProgress);

        if (result.synced > 0) {
            console.log(`✅ [FRIDAY AI] Auto-sync COMPLETE: Indexed ${result.synced} new/modified files from Drive.`);
        } else {
            console.log("✅ [FRIDAY AI] Auto-sync COMPLETE: Local index is already up to date.");
        }

        return result;
    } catch (error) {
        console.error("❌ Auto-sync error:", error);
        return { synced: 0, skipped: 0, error: error.message };
    }
}


// ai-chat/drive-service.js
// Google Drive file fetching and sync using Chrome identity API

import { CONFIG } from "./config.js";
import * as storageService from "./storage-service.js";

// ============================================
// OAuth Token
// ============================================

/**
 * Get Google OAuth access token using Chrome identity API
 */
export async function getAccessToken() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) {
                console.error("OAuth error:", chrome.runtime.lastError);
                reject(new Error(chrome.runtime.lastError.message));
            } else if (!token) {
                reject(new Error("No token received"));
            } else {
                console.log("✅ Got OAuth token");
                resolve(token);
            }
        });
    });
}

// ============================================
// Drive API
// ============================================

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/**
 * List files in a Drive folder
 */
async function listFolderFiles(folderId, accessToken) {
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const fields = "files(id,name,mimeType,modifiedTime)";

    const response = await fetch(
        `${DRIVE_API}/files?q=${query}&fields=${fields}`,
        {
            headers: { Authorization: `Bearer ${accessToken}` },
        }
    );

    if (!response.ok) {
        throw new Error(`Drive API error: ${response.status}`);
    }

    const data = await response.json();
    return data.files || [];
}

/**
 * Download file content from Drive
 */
async function downloadFile(fileId, mimeType, accessToken) {
    // Google Workspace files - export as text
    const exportTypes = {
        "application/vnd.google-apps.document": "text/plain",
        "application/vnd.google-apps.spreadsheet": "text/csv",
        "application/vnd.google-apps.presentation": "text/plain",
    };

    // Office files - need to copy to Google format first, then export
    // OR download and parse on backend (we'll use backend parsing)
    const officeTypes = [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
        "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
        "application/pdf", // .pdf
    ];

    let url;
    if (exportTypes[mimeType]) {
        // Google Workspace files - export as text
        url = `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportTypes[mimeType])}`;
    } else if (officeTypes.includes(mimeType)) {
        // Office/PDF files - download binary and send to backend for parsing
        url = `${DRIVE_API}/files/${fileId}?alt=media`;

        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
            throw new Error(`Download failed: ${response.status}`);
        }

        // Get as blob and send to backend for parsing
        const blob = await response.blob();
        return await parseFileOnBackend(blob, mimeType);
    } else {
        // Regular text files - download directly
        url = `${DRIVE_API}/files/${fileId}?alt=media`;
    }

    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
    }

    return response.text();
}

/**
 * Parse binary files (PDF, DOCX, PPTX) via backend
 */
async function parseFileOnBackend(blob, mimeType) {
    const formData = new FormData();
    formData.append("file", blob);
    formData.append("mimeType", mimeType);

    const response = await fetch(`${CONFIG.SERVER_URL}/parse-file`, {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Parse failed: ${response.status}`);
    }

    const data = await response.json();
    return data.text || "";
}

/**
 * Check if file type is supported for indexing
 */
function isSupportedFile(mimeType) {
    const supported = [
        // Text files
        "text/plain",
        "text/markdown",
        "text/csv",
        // Google Workspace
        "application/vnd.google-apps.document",
        "application/vnd.google-apps.spreadsheet",
        "application/vnd.google-apps.presentation",
        // Office files
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
        "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
        // PDF
        "application/pdf",
    ];
    return supported.includes(mimeType);
}

// ============================================
// Indexing
// ============================================

/**
 * Chunk text for embedding
 */
function chunkText(text, chunkSize = 1000, overlap = 100) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        const end = Math.min(i + chunkSize, text.length);
        chunks.push(text.slice(i, end));
        if (end === text.length) break;
        i = end - overlap;
    }
    return chunks;
}

/**
 * Index a file to Pinecone
 */
async function indexFile(filename, content, meetingId) {
    const chunks = chunkText(content);
    console.log(`📦 Indexing ${filename}: ${chunks.length} chunks`);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Get embedding
        const embedResponse = await fetch(`${CONFIG.SERVER_URL}/ai/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: chunk }),
        });

        if (!embedResponse.ok) {
            console.error(`Embedding failed for chunk ${i}`);
            continue;
        }

        const { embedding } = await embedResponse.json();

        // Upsert to Pinecone
        const vector = {
            id: `${meetingId}_${filename}_${i}`,
            values: embedding,
            metadata: {
                filename,
                meetingId,
                chunkIndex: i,
                content: chunk.slice(0, 1000),
                wordCount: chunk.split(/\s+/).length,
            },
        };

        await fetch(`${CONFIG.SERVER_URL}/upsert`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                namespace: CONFIG.NAMESPACES.getMeetingNs(meetingId),
                vectors: [vector]
            }),
        });

        // Rate limiting
        await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`✅ Indexed ${filename}`);
}

// ============================================
// Sync Flow
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

let syncInProgress = false;

/**
 * Sync files from a Drive folder
 */
export async function syncMeetingFiles(meeting, onProgress) {
    if (syncInProgress) {
        console.log("⏳ Sync already in progress");
        return { synced: 0, skipped: 0 };
    }

    const folderId = extractFolderId(meeting.driveFolderLink);
    if (!folderId) {
        console.log("⚠️ No Drive folder linked to meeting");
        return { synced: 0, skipped: 0, error: "No folder linked" };
    }

    syncInProgress = true;
    let synced = 0;
    let skipped = 0;

    try {
        // Get OAuth token
        const accessToken = await getAccessToken();

        // List files
        onProgress?.("Listing files...");
        const files = await listFolderFiles(folderId, accessToken);
        console.log(`📁 Found ${files.length} files in folder`);

        // Get indexed files
        const indexed = await storageService.getIndexedFiles(meeting.meetingId);

        for (const file of files) {
            if (!isSupportedFile(file.mimeType)) {
                console.log(`⏭️ Skipping unsupported: ${file.name}`);
                skipped++;
                continue;
            }

            // Check if already indexed with same modified time
            if (indexed[file.id] === file.modifiedTime) {
                console.log(`✅ Already indexed: ${file.name}`);
                skipped++;
                continue;
            }

            try {
                onProgress?.(`Indexing ${file.name}...`);

                // Download file
                const content = await downloadFile(file.id, file.mimeType, accessToken);

                if (!content || content.trim().length < 50) {
                    console.log(`⚠️ File too short: ${file.name}`);
                    skipped++;
                    continue;
                }

                // Index to Pinecone
                await indexFile(file.name, content, meeting.meetingId);

                // Mark as indexed
                await storageService.markFileIndexed(meeting.meetingId, file.id, file.modifiedTime);
                synced++;

            } catch (fileError) {
                console.error(`❌ Error processing ${file.name}:`, fileError);
                skipped++;
            }
        }

        console.log(`✅ Sync complete: ${synced} synced, ${skipped} skipped`);
        return { synced, skipped, total: files.length };

    } catch (error) {
        console.error("Sync error:", error);
        return { synced, skipped, error: error.message };
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
 * Checks for new or modified files in background
 */
export async function autoSync(meeting, options = {}) {
    const { silent = true, onProgress } = options;

    if (!meeting?.driveFolderLink) {
        if (!silent) console.log("⚠️ No Drive folder linked");
        return { synced: 0, skipped: 0, noFolder: true };
    }

    const folderId = extractFolderId(meeting.driveFolderLink);
    if (!folderId) return { synced: 0, skipped: 0, error: "Invalid folder URL" };

    console.log("🔄 Auto-sync: Checking for new/modified files...");

    try {
        // Always sync to check for new/modified files
        const result = await syncMeetingFiles(meeting, onProgress);

        if (result.synced > 0) {
            console.log(`✅ Auto-sync: Indexed ${result.synced} new/modified files`);
        } else {
            console.log("✅ Auto-sync: All files up to date");
        }

        return result;
    } catch (error) {
        console.error("❌ Auto-sync error:", error);
        return { synced: 0, skipped: 0, error: error.message };
    }
}

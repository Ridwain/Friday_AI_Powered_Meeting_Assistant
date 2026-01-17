// services/drive.js
// Google Drive API wrapper for file fetching and sync

import fetch from "node-fetch";

// ============================================
// Configuration
// ============================================

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const EXPORT_MIMETYPES = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
};

// ============================================
// File Listing
// ============================================

/**
 * List files in a Drive folder
 */
export async function listFolderFiles(folderId, accessToken) {
    const query = `'${folderId}' in parents and trashed = false`;
    const fields = "files(id,name,mimeType,modifiedTime,size)";

    const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=${fields}`;

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Drive API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.files || [];
}

// ============================================
// File Download
// ============================================

/**
 * Download file content from Drive
 */
export async function downloadFile(fileId, mimeType, accessToken) {
    let url;

    // Check if it's a Google Workspace file that needs export
    if (EXPORT_MIMETYPES[mimeType]) {
        const exportMime = EXPORT_MIMETYPES[mimeType];
        url = `${DRIVE_API_BASE}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`;
    } else {
        url = `${DRIVE_API_BASE}/files/${fileId}?alt=media`;
    }

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Download failed: ${response.status} - ${error}`);
    }

    return response.text();
}

// ============================================
// File Conversion
// ============================================

/**
 * Convert file content to plain text based on mime type
 */
export function convertToText(content, mimeType, filename) {
    // For PDF, we'd need a library like pdf-parse
    // For now, return as-is for text-based files
    if (mimeType.includes("pdf")) {
        // TODO: Add PDF parsing with pdf-parse
        console.warn(`PDF parsing not yet implemented for ${filename}`);
        return content;
    }

    return content;
}

// ============================================
// Sync Logic
// ============================================

/**
 * Check if a file needs re-indexing based on modified time
 */
export function needsReindex(file, indexedFiles) {
    if (!indexedFiles[file.id]) return true;
    return indexedFiles[file.id] !== file.modifiedTime;
}

/**
 * Get supported file types for indexing
 */
export function isSupportedFile(mimeType) {
    const supported = [
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/pdf",
        "application/vnd.google-apps.document",
        "application/vnd.google-apps.spreadsheet",
        "application/vnd.google-apps.presentation",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    return supported.some((type) => mimeType.includes(type) || type.includes(mimeType));
}

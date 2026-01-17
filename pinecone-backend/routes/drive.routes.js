// routes/drive.routes.js
// Express routes for Google Drive sync

import express from "express";
import * as driveService from "../services/drive.js";
import * as ragService from "../services/rag.js";

const router = express.Router();

// In-memory store for indexed files (in production, use database)
const indexedFilesStore = new Map();

// ============================================
// Sync Drive Folder
// ============================================

router.post("/sync", async (req, res) => {
    try {
        const { folderId, meetingId, namespace } = req.body;
        const accessToken = req.headers.authorization?.replace("Bearer ", "");

        if (!folderId || !meetingId) {
            return res.status(400).json({ error: "folderId and meetingId required" });
        }

        if (!accessToken) {
            return res.status(401).json({ error: "Authorization token required" });
        }

        console.log(`📁 Syncing Drive folder ${folderId} for meeting ${meetingId}...`);

        // Get files from Drive
        const files = await driveService.listFolderFiles(folderId, accessToken);
        console.log(`📄 Found ${files.length} files in folder`);

        // Get already indexed files
        const indexedFiles = indexedFilesStore.get(meetingId) || {};

        let syncedCount = 0;
        let skippedCount = 0;
        const errors = [];

        for (const file of files) {
            try {
                // Check if file is supported
                if (!driveService.isSupportedFile(file.mimeType)) {
                    console.log(`⏭️ Skipping unsupported file: ${file.name}`);
                    continue;
                }

                // Check if needs re-indexing
                if (!driveService.needsReindex(file, indexedFiles)) {
                    console.log(`✅ File already indexed: ${file.name}`);
                    skippedCount++;
                    continue;
                }

                // Download file content
                console.log(`⬇️ Downloading: ${file.name}`);
                const content = await driveService.downloadFile(file.id, file.mimeType, accessToken);

                // Convert to text
                const text = driveService.convertToText(content, file.mimeType, file.name);

                if (!text || text.trim().length < 50) {
                    console.log(`⚠️ File has insufficient content: ${file.name}`);
                    continue;
                }

                // Create chunks
                const chunks = ragService.createChunks(text, file.name, meetingId);
                console.log(`📦 Created ${chunks.length} chunks for ${file.name}`);

                // Generate embeddings and upsert to Pinecone
                // This will be done via the existing /upsert endpoint
                // For now, we just prepare the data

                // Mark as indexed
                indexedFiles[file.id] = file.modifiedTime;
                syncedCount++;

                // TODO: Call embedding endpoint and upsert
                // This would be implemented as a separate step

            } catch (fileError) {
                console.error(`❌ Error processing ${file.name}:`, fileError.message);
                errors.push({ file: file.name, error: fileError.message });
            }
        }

        // Update indexed files store
        indexedFilesStore.set(meetingId, indexedFiles);

        console.log(`✅ Sync complete: ${syncedCount} synced, ${skippedCount} skipped`);

        res.json({
            success: true,
            syncedCount,
            skippedCount,
            totalFiles: files.length,
            errors: errors.length > 0 ? errors : undefined,
        });

    } catch (error) {
        console.error("Drive sync error:", error);
        res.status(500).json({ error: "Sync failed", details: error.message });
    }
});

// ============================================
// List Indexed Files
// ============================================

router.get("/files", async (req, res) => {
    try {
        const { meetingId } = req.query;

        if (!meetingId) {
            return res.status(400).json({ error: "meetingId required" });
        }

        const indexedFiles = indexedFilesStore.get(meetingId) || {};
        const fileList = Object.entries(indexedFiles).map(([id, modifiedTime]) => ({
            id,
            modifiedTime,
        }));

        res.json({
            meetingId,
            files: fileList,
            count: fileList.length,
        });

    } catch (error) {
        console.error("Error getting indexed files:", error);
        res.status(500).json({ error: "Failed to get files", details: error.message });
    }
});

export default router;

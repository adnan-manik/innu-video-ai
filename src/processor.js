import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';
import { transcribeAudio, analyzeTranscriptionWithVision } from './ai.js';
import { findEducationalContent } from './library.js';
import { stitchDynamicSequence, extractFrame } from './stitcher.js';

const storage = new Storage();
const BUCKET_NAME = process.env.GOOGLE_STORAGE_BUCKET;
const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET;

/**
 * Downloads a file from GCS to a local path.
 * Supports both raw paths and full GCS URLs.
 */
const downloadFile = async (pathOrUrl, localPath, defaultBucket = BUCKET_NAME) => {
    let bucket = defaultBucket;
    let filename = pathOrUrl;

    if (pathOrUrl.startsWith('http')) {
        try {
            const urlObj = new URL(pathOrUrl);
            const pathParts = urlObj.pathname.substring(1).split('/');
            bucket = pathParts[0];
            filename = pathParts.slice(1).join('/');
        } catch (e) { /* Fallback to treating as raw path */ }
    }
    await storage.bucket(bucket).file(filename).download({ destination: localPath });
};

/**
 * Centralized helper for database status and message updates.
 */
async function updateVideoStatus(rawPath, status, message, extraFields = {}) {
    const sets = [`status = $1`, `message = $2`, `updated_at = NOW()`];
    const params = [status, message, rawPath];
    
    Object.keys(extraFields).forEach((key) => {
        sets.push(`${key} = $${params.length + 1}`);
        params.push(extraFields[key]);
    });

    const query = `UPDATE videos SET ${sets.join(', ')} WHERE raw_video_path = $3`;
    await db.query(query, params);
}

export const processVideoJob = async (fileEvent) => {
    const rawPath = fileEvent.name;
    if (!rawPath?.startsWith('raw/')) return;

    const videoId = path.basename(rawPath, '.mp4');
    const jobId = uuidv4();

    // Define temporary file paths
    const tmp = {
        intro: `/tmp/${jobId}_intro.mp4`,
        raw: `/tmp/${jobId}_raw.mp4`,
        edu: `/tmp/${jobId}_edu.mp4`,
        outro: `/tmp/${jobId}_outro.mp4`,
        frame: `/tmp/${jobId}_frame.jpg`,
        output: `/tmp/${jobId}_final.mp4`
    };

    console.log(`🎬 JOB START: ${videoId}`);

    try {
        // --- STAGE 1: INITIALIZATION & DOWNLOADS ---
        await updateVideoStatus(rawPath, 'processing', 'Downloading assets...');

        await Promise.all([
            downloadFile('videos/intro.mp4', tmp.intro),
            downloadFile('videos/outro.mp4', tmp.outro),
            downloadFile(rawPath, tmp.raw)
        ]);

        // --- STAGE 2: AI PIPELINE ---
        const [framePath, transcription] = await Promise.all([
            extractFrame(tmp.raw, tmp.frame),
            transcribeAudio(tmp.raw)
        ]);

        const analysis = await analyzeTranscriptionWithVision(transcription, framePath);

        // Validation guard clauses
        if (!analysis?.issues?.length) {
            return await updateVideoStatus(rawPath, 'failed', 'no issues detected by AI');
        }
        if (analysis.Issues_related === false) {
            const errorMsg = 'Please mention only one problem per video, or ensure all problems are related.';
            return await updateVideoStatus(rawPath, 'failed', errorMsg);
        }

        // --- STAGE 3: CONTENT MATCHING ---
        let matches;
        try {
            matches = await findEducationalContent(analysis);
        } catch (err) {
            const msg = err.message === "FOCUS_LIMIT_EXCEEDED" ? 'focus on one problem at a time' : 'Internal matching error';
            return await updateVideoStatus(rawPath, 'failed', msg);
        }

        if (!matches?.length) {
            return await updateVideoStatus(rawPath, 'failed', 'no educational content found for detected issues');
        }

        // --- STAGE 4: VIDEO EDITING (STITCHING) ---
        await downloadFile(matches[0].video_url, tmp.edu, LIBRARY_BUCKET);
        if(fs.existsSync(tmp.intro) && fs.existsSync(tmp.outro)) {
            const stitchList = [tmp.intro, tmp.raw, tmp.edu, tmp.outro];
            await stitchDynamicSequence(stitchList, tmp.output);
        } 
        else {
            console.warn("⚠️ Intro or Outro missing, stitching without them.");
            const stitchList = [tmp.raw, tmp.edu];
            await stitchDynamicSequence(stitchList, tmp.output);
        }
        
        const thumbnailPath = rawPath.replace('raw/', 'thumbnails/').replace('.mp4', '.jpg');
        await storage.bucket(BUCKET_NAME).upload(tmp.frame, {
            destination: thumbnailPath,
            metadata: { contentType: 'image/jpeg' }
        });

        // --- STAGE 5: UPLOAD & FINALIZATION ---
        const finalPath = rawPath.replace('raw/', 'processed/');
        await storage.bucket(BUCKET_NAME).upload(tmp.output, { destination: finalPath });

        await updateVideoStatus(rawPath, 'completed', 'Video processed successfully', {
            stitched_video_url: finalPath,
            thumbnail_url: thumbnailPath,
            transcription_text: transcription,
            detected_keywords: analysis.issues[0].keywords
        });

        console.log(`✅ Process Complete: ${videoId}`);

    } catch (e) {
        console.error(`❌ Fatal Error for ${videoId}:`, e);
        await updateVideoStatus(rawPath, 'failed', 'internal processing error');
    } finally {
        // --- STAGE 6: CLEANUP ---
        // Clean up /tmp to avoid storage leaks in serverless environments
        const filesToDelete = Object.values(tmp);
        await Promise.all(filesToDelete.map(file => fs.unlink(file).catch(() => { })));
    }
};
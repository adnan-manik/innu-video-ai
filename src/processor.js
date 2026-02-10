import { Storage } from '@google-cloud/storage';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';
import { transcribeAudio, analyzeTranscriptionWithVision } from './ai.js';
import { findEducationalContent } from './library.js';
import { stitchDynamicSequence, extractFrame } from './stitcher.js';

const storage = new Storage();
const BUCKET_NAME = process.env.GOOGLE_STORAGE_BUCKET;
const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET || BUCKET_NAME;

// Helper to handle URL or Path downloads
const downloadFile = async (pathOrUrl, localPath, defaultBucket = BUCKET_NAME) => {
    let bucket = defaultBucket;
    let filename = pathOrUrl;

    if (pathOrUrl.startsWith('http')) {
        try {
            const urlObj = new URL(pathOrUrl);
            filename = urlObj.pathname.substring(1);
            const parts = filename.split('/');
            bucket = parts[0];
            filename = parts.slice(1).join('/');
        } catch (e) { /* ignore, treat as path */ }
    }
    await storage.bucket(bucket).file(filename).download({ destination: localPath });
};

export const processVideoJob = async (fileEvent) => {
    const rawPath = fileEvent.name;
    if (!rawPath.startsWith('raw/')) return;

    const videoId = path.basename(rawPath, '.mp4');
    const jobId = uuidv4();

    // Local Paths
    const localIntro = `/tmp/${jobId}_intro.mp4`;
    const localRaw = `/tmp/${jobId}_raw.mp4`;
    const localEdu = `/tmp/${jobId}_edu.mp4`;
    const localOutro = `/tmp/${jobId}_outro.mp4`;
    const localFrame = `/tmp/${jobId}_frame.jpg`;
    
    const localOutput = `/tmp/${jobId}_final.mp4`;
    
    // 3. AI Analysis
    console.log(`🎬 JOB START: ${videoId}`);

    try {
        // 1. Parallel Initial Setup: Update DB and Download static assets + Raw Video
        await Promise.all([
            db.query(`UPDATE videos SET status = 'processing' WHERE raw_video_path = $1`, [rawPath]),
            downloadFile('videos/intro.mp4', localIntro), // Cloud-based intro
            downloadFile('videos/outro.mp4', localOutro), // Cloud-based outro
            downloadFile(rawPath, localRaw)
        ]);

        // 2. AI Pipeline (Frame Extraction & Transcription in parallel)
        const [framePath, transcription] = await Promise.all([
            extractFrame(localRaw, localFrame),
            transcribeAudio(localRaw)
        ]);

        const analysis = await analyzeTranscriptionWithVision(transcription, framePath);

        // Validation Logic
        if (!analysis || !analysis.issues || analysis.issues.length === 0) {
            return await failJob(rawPath, 'no issues detected by AI');
        }
        if (analysis.Issues_related === false) {
            return await failJob(rawPath, 'Please mention only one problem per video, or ensure all problems are related to each other');
        }

        // 4. Content Matching
        let matches;
        const stitchList = [localIntro, localRaw];
        try {
            matches = await findEducationalContent(analysis);
        } catch (err) {
            if (err.message === "FOCUS_LIMIT_EXCEEDED") {
                return await failJob(rawPath, 'focus on one problem at a time');
            }
            throw err;
        }
        if (matches.length === 0) {
            return await failJob(rawPath, 'no educational content found for detected issues');
        }
        await downloadFile(matches[0].video_url, localEdu, LIBRARY_BUCKET);
        stitchList.push(localEdu, localOutro);
        
        // 6. Execution: Stitch, Upload, and Finalize
        await stitchDynamicSequence(stitchList, localOutput);

        const finalPath = rawPath.replace('raw/', 'processed/');
        await storage.bucket(BUCKET_NAME).upload(localOutput, { destination: finalPath });

        await db.query(`
      UPDATE videos 
      SET status = 'completed', updated_at = NOW(), stitched_video_url = $1, transcription_text = $2,  detected_keywords = $3, message = 'Video processed successfully' 
      WHERE raw_video_path = $4
    `, [finalPath, transcription, analysis.issues[0].keywords, rawPath]);

        console.log("✅ Process Complete");

    } catch (e) {
        console.error("❌ Fatal Error:", e);
        await failJob(rawPath, 'internal processing error');
    }
};

// Helper to consolidate failure logic
async function failJob(rawPath, message) {
    console.warn(`⚠️ Job Failed: ${message}`);
    await db.query(`
    UPDATE videos 
    SET status = 'failed', message = $1 
    WHERE raw_video_path = $2
  `, [message, rawPath]);
}
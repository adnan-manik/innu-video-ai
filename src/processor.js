import { Storage } from '@google-cloud/storage';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';
import { transcribeAudio, analyzeTranscriptionWithVision } from './ai.js';
import { findEducationalContent } from './library.js';
import { stitchDynamicSequence, extractFrame } from './stitcher.js';

const storage = new Storage();
const BUCKET_NAME = process.env.GOOGLE_STORAGE_BUCKET;
const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET || BUCKET_NAME; // Fallback if same bucket

// Helper to handle URL or Path downloads
const downloadFile = async (pathOrUrl, localPath, defaultBucket = BUCKET_NAME) => {
  let bucket = defaultBucket;
  let filename = pathOrUrl;

  if (pathOrUrl.startsWith('http')) {
    try {
        const urlObj = new URL(pathOrUrl);
        filename = urlObj.pathname.substring(1); // Remove leading slash
        // Assume standard GCS URL structure
        const parts = filename.split('/');
        bucket = parts[0]; 
        filename = parts.slice(1).join('/');
    } catch(e) { /* ignore, treat as path */ }
  }
  await storage.bucket(bucket).file(filename).download({ destination: localPath });
};

export const processVideoJob = async (fileEvent) => {
  const rawPath = fileEvent.name; 
  if (!rawPath.startsWith('raw/')) return;
  
  const videoId = path.basename(rawPath, '.mp4'); 
  const jobId = uuidv4();
  
  // Local Paths
  const localInput = `/tmp/${jobId}_raw.mp4`;
  const localFrame = `/tmp/${jobId}_frame.jpg`;
  const localOutput = `/tmp/${jobId}_final.mp4`;

  console.log(`🎬 JOB START: ${videoId}`);

  try {
    // 1. Update DB Status
    await db.query(`UPDATE videos SET status = 'processing' WHERE raw_video_path = $1`, [rawPath]);

    // 2. Download Raw Video (Blocking - needed for AI)
    console.log("⬇️ Downloading Raw Video...");
    await storage.bucket(BUCKET_NAME).file(rawPath).download({ destination: localInput });

    // 3. Parallel AI Processing (Frame Extract + Transcription)
    console.log("🤖 Starting AI Pipeline...");
    
    // Run these at the same time
    const [framePath, transcription] = await Promise.all([
        extractFrame(localInput, localFrame),
        transcribeAudio(localInput)
    ]);

    // 4. Vision Analysis
    console.log("🧠 Analyzing with Vision...");
    const analysis = await analyzeTranscriptionWithVision(transcription, framePath);
    console.log("AI Result:", JSON.stringify(analysis, null, 2));

    // 5. Find Content in DB
    const matches = await findEducationalContent(analysis);
    console.log(`🔍 Found ${matches.length} Educational Matches`);

    // 6. Prepare Stitch List & Download Edu Videos
    const stitchList = [path.resolve('assets/intro.mp4'), localInput];
    const downloadQueue = [];

    for (const match of matches) {
        // Insert Audit Record
        await db.query(`
            INSERT INTO video_edit_details 
            (video_id, problem_label, ai_keywords, ai_selected_vid, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
        `, [videoId, match.problem, match.keywords, match.library_id]);

        if (match.video_url) {
            const localEdu = `/tmp/${jobId}_${match.library_id}.mp4`;
            // Queue download for parallel execution
            downloadQueue.push(downloadFile(match.video_url, localEdu, LIBRARY_BUCKET));
            stitchList.push(localEdu);
        }
    }

    // Wait for all educational videos to finish downloading
    if (downloadQueue.length > 0) {
        console.log(`⬇️ Downloading ${downloadQueue.length} Edu Clips...`);
        await Promise.all(downloadQueue);
    }

    stitchList.push(path.resolve('assets/outro.mp4'));

    // 7. Stitch (Ultrafast)
    console.log("🧵 Stitching...");
    await stitchDynamicSequence(stitchList, localOutput);
    
    // 8. Upload Result
    const finalPath = rawPath.replace('raw/', 'processed/');
    console.log("⬆️ Uploading Final Video...");
    await storage.bucket(BUCKET_NAME).upload(localOutput, { destination: finalPath });

    // 9. Cleanup DB
    await db.query(`
        UPDATE videos 
        SET status = 'completed', processed_video_path = $1, transcription_text = $2 
        WHERE raw_video_path = $3
    `, [finalPath, transcription, rawPath]);

    console.log("✅ JOB COMPLETE");

  } catch (e) {
    console.error("❌ FATAL ERROR:", e);
    await db.query(`UPDATE videos SET status = 'failed' WHERE raw_video_path = $1`, [rawPath]);
  }
};

// ------------------------------------
// JOB 2: RE-STITCH (User Edit)
// ------------------------------------
export const processReStitchJob = async (videoId) => {
    console.log(`♻️ Re-Stitching: ${videoId}`);
    const jobId = uuidv4();
    
    try {
        // 1. Get the Blueprint (User Choice > AI Choice)
        const blueprint = await db.query(`
            SELECT v.raw_video_path, el.video_url, el.id as lib_id
            FROM video_edit_details ved
            JOIN videos v ON v.id = ved.video_id
            LEFT JOIN educational_library el 
                ON el.id = COALESCE(ved.user_selected_vid, ved.ai_selected_vid)
            WHERE ved.video_id = $1
            ORDER BY ved.edit_id ASC
        `, [videoId]);

        if (blueprint.rows.length === 0) return console.log("No segments found");

        const rawPath = blueprint.rows[0].raw_video_path;
        const localRaw = `/tmp/${jobId}_raw.mp4`;
        const localOutput = `/tmp/${jobId}_regen.mp4`;

        // 2. Download Raw
        await storage.bucket(BUCKET_NAME).file(rawPath).download({ destination: localRaw });
        
        const stitchList = [path.resolve('assets/intro.mp4'), localRaw];

        // 3. Download Corrected Clips
        for (const row of blueprint.rows) {
            if (row.video_url) {
                const localEdu = `/tmp/${jobId}_${row.lib_id}.mp4`;
                await downloadFile(row.video_url, localEdu);
                stitchList.push(localEdu);
            }
        }
        
        stitchList.push(path.resolve('assets/outro.mp4'));

        // 4. Stitch & Overwrite
        await stitchDynamicSequence(stitchList, localOutput);
        
        const finalPath = rawPath.replace('raw/', 'processed/');
        await storage.bucket(BUCKET_NAME).upload(localOutput, { destination: finalPath });
        
        // Update Timestamp to notify app of change
        await db.query(`UPDATE videos SET updated_at = NOW() WHERE id = $1`, [videoId]);
        console.log("✅ Re-Stitch Complete");

    } catch (e) {
        console.error("Re-stitch failed", e);
    }
};
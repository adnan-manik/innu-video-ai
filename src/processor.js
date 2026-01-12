import { Storage } from '@google-cloud/storage';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';
import { transcribeAudio, analyzeTranscription } from './ai.js';
import { findEducationalContent } from './library.js';
import { stitchDynamicSequence } from './stitcher.js';

const storage = new Storage();
const BUCKET_NAME = process.env.GOOGLE_STORAGE_BUCKET;

// Helper to download files
const downloadFile = async (remotePath, localPath) => {
  // If remotePath is a full URL, you might need axios/fetch. 
  // Assuming it is a GS path "videos/edu/1.mp4" for this example:
  await storage.bucket(BUCKET_NAME).file(remotePath).download({ destination: localPath });
};

// ------------------------------------
// JOB 1: NEW VIDEO UPLOAD (First Run)
// ------------------------------------
export const processVideoJob = async (fileEvent) => {
  const rawPath = fileEvent.name; 
  if (!rawPath.startsWith('raw/')) return;
  
  // Extract Video UUID from path: raw/ORDER_ID/VIDEO_ID.mp4
  const videoId = path.basename(rawPath, '.mp4'); 
  const jobId = uuidv4();
  const localInput = `/tmp/${jobId}_raw.mp4`;
  const localOutput = `/tmp/${jobId}_final.mp4`;

  try {
    await db.query(`UPDATE videos SET status = 'processing' WHERE raw_video_path = $1`, [rawPath]);

    // 1. Download & Analyze
    await storage.bucket(BUCKET_NAME).file(rawPath).download({ destination: localInput });
    const transcription = await transcribeAudio(localInput);
    const analysis = await analyzeTranscription(transcription);
    const matches = await findEducationalContent(analysis);

    const stitchList = [path.resolve('assets/intro.mp4'), localInput];

    // 2. Insert into DB & Build List
    for (const match of matches) {
        // Insert "Audit" record (AI Only)
        await db.query(`
            INSERT INTO video_edit_details 
            (video_id, problem_label, ai_keywords, ai_selected_vid, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
        `, [videoId, match.problem, match.keywords, match.library_id]);

        if (match.video_url) {
            const localEdu = `/tmp/${jobId}_${match.library_id}.mp4`;
            await downloadFile(match.video_url, localEdu);
            stitchList.push(localEdu);
        }
    }

    stitchList.push(path.resolve('assets/outro.mp4'));

    // 3. Stitch & Upload
    await stitchDynamicSequence(stitchList, localOutput);
    
    const finalPath = rawPath.replace('raw/', 'processed/');
    await storage.bucket(BUCKET_NAME).upload(localOutput, { destination: finalPath });

    await db.query(`
        UPDATE videos 
        SET status = 'completed', processed_video_path = $1, transcription_text = $2 
        WHERE raw_video_path = $3
    `, [finalPath, transcription, rawPath]);

    console.log("✅ Initial Video Created");

  } catch (e) {
    console.error(e);
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
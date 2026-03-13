import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { transcribeAudio, analyzeTranscriptionWithVision } from "./ai.js";
import { findEducationalContent } from "./library.js";
import { stitchDynamicSequence, extractFrame } from "./stitcher.js";
import { extractAudio } from "./extractAudio.js";
import { existsSync } from "fs";

// Mount points 
const VIDEO_BUCKET = "/video-app";
const LIBRARY_BUCKET = "/edu_videos";

const getMetadata = async (rawPath) => {
  const query = `
    SELECT 
      s.name as shop_name, 
      o.vehicle_info,
      s.id as shop_id
    FROM videos v
    JOIN orders o ON v.order_id = o.id
    JOIN shops s ON o.shop_id = s.id
    WHERE v.raw_video_path = $1
    LIMIT 1;
  `;

  const result = await db.query(query, [rawPath]);
  let data;

  if (result.rows.length === 0) {
    console.warn(`⚠️ No metadata found for ${rawPath}, using defaults`);
    data = {
      shopName: "Service Inspection",
      vehicleName: "Vehicle",
      shopLogo: null
    };
  } else {
    const row = result.rows[0];

    // Parse the JSONB vehicle_info column
    let vehicleInfo = {};
    try {
      vehicleInfo = typeof row.vehicle_info === 'string'
        ? JSON.parse(row.vehicle_info)
        : row.vehicle_info;
    } catch (e) {
      console.error("Error parsing vehicle_info:", e);
    }
    const shopLogoPath = path.join(VIDEO_BUCKET, "shop_logos", `${row.shop_id}.png`);
    data = {
      vehicleName: `${vehicleInfo.make || ''} ${vehicleInfo.model || ''}`.trim(),
      shopName: row.shop_name,
      shopLogo: existsSync(shopLogoPath) ? shopLogoPath : null
    };
  }
  return data;
};


async function updateVideoStatus(rawPath, status, message, extraFields = {}) {
  const sets = [`status = $1`, `message = $2`, `updated_at = NOW()`];
  const params = [status, message, rawPath];

  Object.keys(extraFields).forEach((key) => {
    sets.push(`${key} = $${params.length + 1}`);
    params.push(extraFields[key]);
  });

  const query = `UPDATE videos SET ${sets.join(", ")} WHERE raw_video_path = $3`;
  await db.query(query, params);
}

export const processVideoJob = async (fileEvent) => {
  const rawPath = fileEvent.name;
  if (!rawPath?.startsWith("raw/")) return;

  const jobId = uuidv4();
  const tmp = {
    audio: `/tmp/${jobId}_audio.mp3`,
    frame: `/tmp/${jobId}_frame.jpg`,
  };
  console.log(`🎬 Starting processing for: ${rawPath}`);
  try {
    await updateVideoStatus(rawPath, "processing", "Performing AI Analysis...");
    const rawInput = path.join(VIDEO_BUCKET, rawPath);

    // 1. AI PIPELINE
    const [tempFrame, transcription] = await Promise.all([
      extractFrame(rawInput, tmp.frame),
      (async () => {
        await extractAudio(rawInput, tmp.audio);
        return transcribeAudio(tmp.audio);
      })(),
    ]);

    const analysis = await analyzeTranscriptionWithVision(transcription, tempFrame);

    if (!analysis?.issues?.length) {
      console.log("No issues detected by AI, marking as failed");
      return await updateVideoStatus(rawPath, "failed", "no issues detected by AI");
    }
    console.log(`✅ AI analysis complete, Finding educationl video`);
    // 2. CONTENT MATCHING
    await updateVideoStatus(rawPath, "processing", "Matching educational content...");
    let matches;
    try {
      matches = await findEducationalContent(analysis);
    } catch (err) {
      const msg =
        err.message === "FOCUS_LIMIT_EXCEEDED"
          ? "focus on one problem at a time"
          : "Internal matching error";
      return await updateVideoStatus(rawPath, "failed", msg);
    }

    if (!matches?.length) {
      return await updateVideoStatus(
        rawPath,
        "failed",
        "no educational content found for detected issues",
      );
    }

    console.log(`✅ Content matching complete, found ${matches.length} matches`);
    // 3. STITCHING (Sequential to avoid race conditions)
    await updateVideoStatus(rawPath, "processing", "Stitching final video...");

    const eduVideo = path.join(LIBRARY_BUCKET, matches[0].video_url);
    const finalOutput = path.join(VIDEO_BUCKET, rawPath.replace("raw/", "processed/"));
    const thumbnailPath = path.join(VIDEO_BUCKET, rawPath.replace("raw/", "thumbnails/").replace(".mp4", ".jpg"));

    const metadata = await getMetadata(rawPath);

    // Run stitcher, THEN extract frame from the result
    await stitchDynamicSequence([rawInput, eduVideo], finalOutput, metadata);
    await extractFrame(finalOutput, thumbnailPath);

    // 4. FINALIZATION
    await updateVideoStatus(rawPath, "completed", "Video processed successfully", {
      stitched_video_url: finalOutput,
      thumbnail_url: thumbnailPath,
      transcription_text: transcription,
      detected_keywords: JSON.stringify(analysis.issues),
      edu_video_id: matches[0].library_id
    });
    console.log(`✅ Processing complete for: ${rawPath}`);
  } catch (e) {
    console.error(`❌ Process Error:`, e);
    await updateVideoStatus(rawPath, "failed", "internal processing error");
  } finally {
    await Promise.all(Object.values(tmp).map(f => fs.unlink(f).catch(() => { })));
  }
};

export const processRestitchJob = async (video) => {
  const rawPath = video.raw_video_path;
  const jobId = uuidv4();
  const tmp = { frame: `/tmp/${jobId}_frame.jpg` };

  console.log(`🎬 Starting restitching for: ${rawPath}`);

  try {
    await updateVideoStatus(rawPath, "processing", "Restitching video...");

    const [metadata, eduResult] = await Promise.all([
      getMetadata(rawPath),
      db.query(`SELECT video_url, title, category FROM educational_library WHERE id = $1`, [video.edu_video_id])
    ]);

    if (!eduResult.rows.length) {
      console.warn(`⚠️ Educational video not found for edu_video_id: ${video.edu_video_id}`);
      return await updateVideoStatus(rawPath, "failed", "Educational video not found");
    }

    const rawInput = path.join(VIDEO_BUCKET, rawPath);
    const eduVideo = path.join(LIBRARY_BUCKET, eduResult.rows[0].video_url);
    const finalOutput = path.join(VIDEO_BUCKET, rawPath.replace("raw/", "processed/").replace(".mp4", "_restitched.mp4"));
    const thumbnailPath = path.join(VIDEO_BUCKET, rawPath.replace("raw/", "thumbnails/").replace(".mp4", "_restitched.jpg"));

    console.log("Starting Sticthing...");
    // Sequential: Wait for stitch before frame extraction
    await stitchDynamicSequence([rawInput, eduVideo], finalOutput, metadata);
    await extractFrame(finalOutput, thumbnailPath);
    // 1. Determine the correct keywords to save

    
    console.log(`keywords type: ${typeof video.detected_keywords}, value: ${video.detected_keywords}`);

    // 3. Update the DB
    await updateVideoStatus(rawPath, "completed", "Video restitched successfully", {
      stitched_video_url: finalOutput,
      thumbnail_url: thumbnailPath,
      edu_video_id: video.edu_video_id
    });
    console.log(`✅ Restitching complete for: ${rawPath}`);
  } catch (e) {
    console.error(`❌ Restitch Error:`, e);
    await updateVideoStatus(rawPath, "failed", "internal restitch error");
  } finally {
    await Promise.all(Object.values(tmp).map(f => fs.unlink(f).catch(() => { })));
  }
};
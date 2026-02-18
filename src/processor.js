import { Storage } from "@google-cloud/storage";
import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { transcribeAudio, analyzeTranscriptionWithVision } from "./ai.js";
import { findEducationalContent } from "./library.js";
import { stitchDynamicSequence, extractFrame } from "./stitcher.js";

const storage = new Storage();
const BUCKET_NAME = process.env.GOOGLE_STORAGE_BUCKET;
const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET;

/**
 * Downloads a file from GCS to a local path.
 * Supports both raw paths and full GCS URLs.
 */
const downloadFile = async (
  pathOrUrl,
  localPath,
  defaultBucket = BUCKET_NAME,
) => {
  let bucket = defaultBucket;
  let filename = pathOrUrl;

  if (pathOrUrl.startsWith("http")) {
    try {
      const urlObj = new URL(pathOrUrl);
      const pathParts = urlObj.pathname.substring(1).split("/");
      bucket = pathParts[0];
      filename = pathParts.slice(1).join("/");
    } catch (e) {
      /* Fallback to treating as raw path */
    }
  }
  await storage
    .bucket(bucket)
    .file(filename)
    .download({ destination: localPath });
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

  const query = `UPDATE videos SET ${sets.join(", ")} WHERE raw_video_path = $3`;
  await db.query(query, params);
}

export const processVideoJob = async (fileEvent) => {
  const rawPath = fileEvent.name;
  if (!rawPath?.startsWith("raw/")) return;

  const videoId = path.basename(rawPath, ".mp4");
  const jobId = uuidv4();

  // Define temporary file paths
  const tmp = {
    intro: `/tmp/${jobId}_intro.mp4`,
    raw: `/tmp/${jobId}_raw.mp4`,
    edu: `/tmp/${jobId}_edu.mp4`,
    outro: `/tmp/${jobId}_outro.mp4`,
    frame: `/tmp/${jobId}_frame.jpg`,
    output: `/tmp/${jobId}_final.mp4`,
  };

  console.log(`🎬 JOB START: ${videoId}`);

  try {
    // --- STAGE 1: INITIALIZATION & DOWNLOADS ---
    await updateVideoStatus(rawPath, "processing", "Downloading assets...");

    await Promise.all([
      downloadFile("videos/intro.mp4", tmp.intro),
      downloadFile("videos/outro.mp4", tmp.outro),
      downloadFile(rawPath, tmp.raw),
    ]);
    console.log("Assets ready, Starting AI Pipeline");
    // --- STAGE 2: AI PIPELINE ---
    const [framePath, transcription] = await Promise.all([
      extractFrame(tmp.raw, tmp.frame),
      transcribeAudio(tmp.raw),
    ]);

    const analysis = await analyzeTranscriptionWithVision(
      transcription,
      framePath,
    );

    // Validation guard clauses
    if (!analysis?.issues?.length) {
      return await updateVideoStatus(
        rawPath,
        "failed",
        "no issues detected by AI",
      );
    }
    if (analysis.Issues_related === false) {
      const errorMsg =
        "Please mention only one problem per video, or ensure all problems are related.";
      return await updateVideoStatus(rawPath, "failed", errorMsg);
    }

    // --- STAGE 3: CONTENT MATCHING ---
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

    // --- STAGE 4: VIDEO EDITING (STITCHING) ---
    await downloadFile(matches[0].video_url, tmp.edu, LIBRARY_BUCKET);

    const stitchList = [tmp.intro, tmp.raw, tmp.edu, tmp.outro];
    console.log("AI processing done, Stitching...");
    await stitchDynamicSequence(stitchList, tmp.output);

    const thumbnailPath = rawPath
      .replace("raw/", "thumbnails/")
      .replace(".mp4", ".jpg");
    await storage.bucket(BUCKET_NAME).upload(tmp.frame, {
      destination: thumbnailPath,
      metadata: { contentType: "image/jpeg" },
    });
    console.log("Processing completed, Uploading final video...");
    // --- STAGE 5: UPLOAD & FINALIZATION ---
    const finalPath = rawPath.replace("raw/", "processed/");
    await storage
      .bucket(BUCKET_NAME)
      .upload(tmp.output, { destination: finalPath });

    let msg;
    if (matches[0].title == matches[0].category) {
      msg = `Video processed successfully but fallback content was used.`;
    } else {
      msg = "Video processed successfully";
    }
    await updateVideoStatus(rawPath, "completed", msg, {
      stitched_video_url: finalPath,
      thumbnail_url: thumbnailPath,
      transcription_text: transcription,
      detected_keywords: JSON.stringify(analysis.issues),
    });

    console.log(`✅ Process Complete: ${videoId}`);
  } catch (e) {
    console.error(`❌ Fatal Error for ${videoId}:`, e);
    await updateVideoStatus(rawPath, "failed", "internal processing error");
  } finally {
    // --- STAGE 6: CLEANUP ---
    // Clean up /tmp to avoid storage leaks in serverless environments
    const filesToDelete = Object.values(tmp);
    await Promise.all(
      filesToDelete.map((file) => fs.unlink(file).catch(() => {})),
    );
  }
};

export const processRestitchJob = async (video) => {
  const rawPath = video.raw_video_path;
  const videoId = video.id;

  const tmp = {
    intro: `/tmp/${videoId}_intro.mp4`,
    raw: `/tmp/${videoId}_raw.mp4`,
    edu: `/tmp/${videoId}_edu.mp4`,
    outro: `/tmp/${videoId}_outro.mp4`,
    frame: `/tmp/${videoId}_frame.jpg`,
    output: `/tmp/${videoId}_final.mp4`,
  };
  if(!video || !video.videoId){
    console.log(`Incomplete or invalid data: ${JSON.stringify(video)}`)
    return;
  }
  console.log(`🎬 Restitch JOB START: ${videoId}`);

  try {
    // --- STAGE 1: DOWNLOAD REQUIRED FILES ---
    await updateVideoStatus(rawPath, "processing", "Restitching video...");

    // Get educational video path from DB
    const eduResult = await db.query(
      `SELECT video_url FROM educational_library WHERE id = $1`,
      [video.edu_video_id],
    );

    if (!eduResult.rows.length) {
      return await updateVideoStatus(
        rawPath,
        "failed",
        "Educational video not found",
      );
    }

    const eduVideoUrl = eduResult.rows[0].video_url;

    await Promise.all([
      downloadFile("videos/intro.mp4", tmp.intro),
      downloadFile("videos/outro.mp4", tmp.outro),
      downloadFile(rawPath, tmp.raw),
      downloadFile(eduVideoUrl, tmp.edu, LIBRARY_BUCKET),
    ]);

    console.log("Assets downloaded. Starting stitching...");

    // --- STAGE 2: STITCH ---
    const stitchList = [tmp.intro, tmp.raw, tmp.edu, tmp.outro];
    await stitchDynamicSequence(stitchList, tmp.output);

    // Generate new thumbnail
    await extractFrame(tmp.raw, tmp.frame);

    const thumbnailPath = rawPath
      .replace("raw/", "thumbnails/")
      .replace(".mp4", "_restitched.jpg");

    await storage.bucket(BUCKET_NAME).upload(tmp.frame, {
      destination: thumbnailPath,
      metadata: { contentType: "image/jpeg" },
    });

    // --- STAGE 3: UPLOAD FINAL VIDEO ---
    let finalPath = rawPath.replace("raw/", "processed/");
    finalPath = finalPath.replace(".mp4", "_restitched.mp4");
    await storage.bucket(BUCKET_NAME).upload(tmp.output, {
      destination: finalPath,
    });

    await updateVideoStatus(
      rawPath,
      "completed",
      "Video restitched successfully",
      {
        stitched_video_url: finalPath,
        thumbnail_url: thumbnailPath,
      },
    );

    console.log(`✅ Restitch Complete: ${videoId}`);
  } catch (e) {
    console.error(`❌ Restitch Fatal Error for ${videoId}:`, e);
    await updateVideoStatus(rawPath, "failed", "internal restitch error");
  } finally {
    const filesToDelete = Object.values(tmp);
    await Promise.all(
      filesToDelete.map((file) => fs.unlink(file).catch(() => {})),
    );
  }
};

import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { existsSync, statSync } from "fs";

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobe.path);

/**
 * Extracts a high-quality thumbnail from a video file.
 * Compatible with GCS FUSE mount paths.
 */
export const extractFrame = (inputPath, outputPath) => {
  return new Promise(async (resolve, reject) => {
    // Ensure the output directory exists on the mount
    const folder = path.dirname(outputPath);
    const filename = path.basename(outputPath);
    await fs.mkdir(folder, { recursive: true });
    
    const orientation = await detectOrientation(inputPath);
    const { w, h } = orientation === "portrait" ? { w: 720, h: 1280 } : { w: 1280, h: 720 };

    ffmpeg(inputPath)
      .screenshots({
        // Extract frame at 3 second mark (or 0 if video is very short)
        timestamps: [3],
        filename: filename,
        folder: folder,
        // Match your target resolution
        size: `${w}x${h}`
      })
      .on('end', () => {
        console.log(`✅ Frame extracted to: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`❌ Frame extraction error: ${err.message}`);
        reject(err);
      });
  });
};

export const stitchDynamicSequence = async (fileList, outputPath, metadata) => {
  console.time("stitching")
  const id = Date.now() + "_" + Math.floor(Math.random() * 1000);
  const tmp = (name) => path.join(os.tmpdir(), `${id}_${name}`);

  const tempFiles = {
    outro: tmp("outro.mp4")
  };

  try {

    // Create output directory if it doesn't exist (important for GCS FUSE mounts)
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    // 1. Detect Orientation & Hardware Specs
    const orientation = await detectOrientation(fileList[0]);
    const target = orientation === "portrait" ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
    if (metadata.shopLogo) {
      if (!existsSync(metadata.shopLogo)) {
        console.warn("⚠️ Shop logo not found at path:", metadata.shopLogo);
      } else {
        await createOutro(metadata.shopLogo, tempFiles.outro, target);
        fileList.push(tempFiles.outro);
      }
    }
    await stitchSequence(fileList, outputPath, target); // This will handle normalization internally
    console.log("✅ Video Stitched Successfully with Audio Insurance");

  } catch (error) {
    console.error("❌ Critical Failure in Sequence:", error);
    throw error;
  } finally {
    if (existsSync(tempFiles.outro)) await fs.unlink(tempFiles.outro);
    console.log("🧹 Cleanup complete");
    console.timeLog("stitching")
  }
};


/* -------------------------------- */
/* ORIENTATION DETECTION            */
/* -------------------------------- */

const detectOrientation = (file) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);

      const stream = data.streams.find(s => s.width && s.height);
      if (!stream) return reject(new Error("No video stream found"));

      // Check for rotation in side_data (standard in newer FFmpeg)
      let rotation = 0;
      if (stream.side_data_list) {
        const sideData = stream.side_data_list.find(sd => sd.rotation !== undefined);
        if (sideData) rotation = Math.abs(sideData.rotation);
      }
      // Fallback for older metadata formats
      else if (stream.tags && stream.tags.rotate) {
        rotation = Math.abs(parseInt(stream.tags.rotate));
      }

      // If rotation is 90 or 270, the width and height are effectively swapped
      const isRotated = rotation === 90 || rotation === 270;
      const effectiveWidth = isRotated ? stream.height : stream.width;
      const effectiveHeight = isRotated ? stream.width : stream.height;

      resolve(effectiveHeight > effectiveWidth ? "portrait" : "landscape");
    });
  });
};

/* -------------------------------- */
/* INTRO TEXT                       */
/* -------------------------------- */

const addIntroText = (input, output, title, subtitle, target) => {
  return new Promise((resolve, reject) => {
    const { w, h } = target;
    const iw_val = w < h ? w : Math.floor(w / 1.2);
    const fontPath = './font.ttf';

    const duration = 3;
    const slideTime = 0.5;
    const centerX = Math.floor((w - iw_val) / 2);

    // Static centered X for drawbox — no animation
    const textMoveX = `if(lt(t,${slideTime}),-w+(t/${slideTime})*(w+(w-text_w)/2),if(gt(t,${duration - slideTime}),(w-text_w)/2+((t-(${duration - slideTime}))/${slideTime})*w,(w-text_w)/2))`;

    const titleText = title.toUpperCase().replace(/'/g, "\u2019");
    const subtitleText = subtitle.replace(/'/g, "\u2019");

    const filterString = [
      // Static drawboxes — no dynamic x expression
      `drawbox=x=${centerX}:y=${h / 2 - 80}:w=${iw_val}:h=160:color=black@0.4:t=fill:enable='between(t,0,${duration})'`,
      `drawbox=x=${centerX}:y=${h / 2 - 55}:w=${iw_val}:h=3:color=white@0.8:t=fill:enable='between(t,0,${duration})'`,
      `drawbox=x=${centerX}:y=${h / 2 + 25}:w=${iw_val}:h=3:color=white@0.8:t=fill:enable='between(t,0,${duration})'`,
      // Sliding text still works fine
      `drawtext=text='${titleText}':fontfile=${fontPath}:fontsize=56:fontcolor=white:borderw=1:bordercolor=white:x=${textMoveX}:y=${h / 2 - 40}:enable='between(t,0,${duration})'`,
      `drawtext=text='${subtitleText}':fontfile=${fontPath}:fontsize=24:fontcolor=white:borderw=1:bordercolor=white:x=${textMoveX}:y=${h / 2 + 35}:enable='between(t,0,${duration})'`
    ].join(',');

    ffmpeg(input)
      .outputOptions([
        `-filter_complex`, filterString,
        `-c:v`, `libx264`,
        `-preset`, `superfast`,
        `-crf`, `23`,
        `-c:a`, `copy`
      ])
      .on("start", (cmd) => console.log("🚀 FFmpeg Command:", cmd))
      .on("end", () => resolve(output))
      .on("error", (err) => {
        console.error("❌ Intro Text Error:", err.message);
        reject(err);
      })
      .save(output);
  });
};


/* -------------------------------- */
/* OUTRO IMAGE                      */
/* -------------------------------- */

const createOutro = (image, output, target) => {
  const { w, h } = target;

  return new Promise((resolve, reject) => {
    const videoFilter = [
      // 1. Create the blurred background from the static image
      `[0:v]loop=loop=-1:size=1:start=0,scale=${w}:${h}:force_original_aspect_ratio=increase,avgblur=sizeX=20:sizeY=20,crop=${w}:${h},trim=duration=2[bg]`,

      // 2. Create the clear foreground logo/image
      `[0:v]loop=loop=-1:size=1:start=0,scale=${w}:${h}:force_original_aspect_ratio=decrease,trim=duration=2[fg]`,

      // 3. Overlay the logo on the blur and set final format
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[vout]`
    ].join(';');

    const audioFilter = `aevalsrc=0:c=stereo:s=44100:d=2[aout]`;

    ffmpeg()
      .input(image)
      .complexFilter(`${videoFilter};${audioFilter}`)
      .map('[vout]')
      .map('[aout]')
      .outputOptions([
        `-t`, `2`,
        `-c:v`, `libx264`,
        `-c:a`, `aac`,
        `-movflags`, `+faststart`
      ])
      .on("end", () => resolve(output))
      .on("error", (err) => {
        console.error("❌ Outro Error:", err.message);
        reject(err);
      })
      .save(output);
  });
};

/* -------------------------------- */
/* STITCH          */
/* -------------------------------- */
export const stitchSequence = (fileList, outputPath, target) => {
  return new Promise((resolve, reject) => {
    if (fileList.length === 0) return reject(new Error("No files provided for stitching."));
    const { w, h } = target;
    const isPortrait = h > w;
    // 1. Calculate Total Input Size in MB
    let totalSizeInMB = 0;
    try {
      const totalBytes = fileList.reduce((acc, file) => acc + statSync(file).size, 0);
      totalSizeInMB = totalBytes / (1024 * 1024);
      console.log(`📊 Total Input Size: ${totalSizeInMB.toFixed(2)} MB`);
    } catch (err) {
      console.warn("⚠️ Could not read file sizes. Defaulting to Size Priority.");
      totalSizeInMB = 150; // Fallback to heavy compression if fs fails
    }

    // 2. Define Output Options dynamically
    let outputOptions = [
      '-map [v]',
      '-map [a]',
      '-c:v libx264',
      '-movflags +faststart', // Essential for fast web playback
      '-shortest'             // Stop encoding when the shortest stream ends
    ];

    if (totalSizeInMB < 95) {
      console.log("🚀 < 100MB: Prioritizing Quality & Speed (Superfast/CRF23)");
      outputOptions.push(
        '-preset superfast',   // Highest speed (sacrifices compression efficiency, but we don't care here)
        '-crf 23',             // High visual quality
        '-c:a aac',            // Compress audio
        '-b:a 128k'            // Good audio quality
      );
    } else {
      // 🗜️ >= 100MB: Prioritize SIZE and BALANCE (Speed/Quality)
      console.log("🗜️ >= 100MB: Prioritizing Size (Fast/CRF28/Maxrate)");
      outputOptions.push(
        '-preset fast',        // Balanced speed (gives CPU time to actually compress the file)
        '-crf 28',             // Lower quality / higher compression
        '-maxrate 2.5M',       // Hard cap on video bitrate to prevent size spikes
        '-bufsize 5M',         // Required when using maxrate
        '-c:a aac',            // Compress audio
        '-b:a 96k'             // Lower audio bitrate to save maximum space
      );
    }

    // 3. Build the complex filter for standardization (720p, 30fps)
    const filterComplex = fileList.map((_, i) => {
      if (isPortrait) {
        return [
          `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,avgblur=sizeX=40:sizeY=40,crop=${w}:${h},setsar=1:1[bg${i}]`,
          `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1:1[fg${i}]`,
          `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p[v${i}]`,
          `[${i}:a]aresample=async=1,aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`
        ].join(';');
      } else {
        return [
          `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1:1,fps=30,format=yuv420p[v${i}]`,
          `[${i}:a]aresample=async=1,aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`
        ].join(';');
      }
    }).join(';');

    const inputStreams = fileList.map((_, i) => `[v${i}][a${i}]`).join('');

    // 4. Run FFmpeg
    const command = ffmpeg();
    fileList.forEach(file => command.input(file));

    console.log("⏳ Starting FFmpeg Stitching Process...");

    command
      .complexFilter(`${filterComplex};${inputStreams}concat=n=${fileList.length}:v=1:a=1[v][a]`)
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('end', () => {
        // Log the final output size so you can see if your logic worked
        try {
          const outSizeMB = fs.statSync(outputPath).size / (1024 * 1024);
          console.log(`✅ Stitching Complete! Final Output Size: ${outSizeMB.toFixed(2)} MB`);
        } catch (e) {
          console.log("✅ Stitching Complete!");
        }
        resolve(outputPath);
      })
      .on('error', (err, stdout, stderr) => {
        console.error("❌ FFmpeg Stitching Error:", stderr);
        reject(err);
      })
      .run();
  });
};

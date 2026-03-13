import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import path from "path";
import os from "os";
import fs from "fs/promises";

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobe.path);

/**
 * Extracts a high-quality thumbnail from a video file.
 * Compatible with GCS FUSE mount paths.
 */
export const extractFrame = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    // Ensure the output directory exists on the mount
    const folder = path.dirname(outputPath);
    const filename = path.basename(outputPath);

    ffmpeg(inputPath)
      .screenshots({
        // Extract frame at 3 second mark (or 0 if video is very short)
        timestamps: [3],
        filename: filename,
        folder: folder,
        // Match your target resolution
        size: '1280x720'
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
  const id = Date.now() + "_" + Math.floor(Math.random() * 1000);
  const tmp = (name) => path.join(os.tmpdir(), `${id}_${name}`);

  const tempFiles = {
    n1: tmp("n1.mp4"),
    n2: tmp("n2.mp4"),
    outro: tmp("outro_stage.mp4")
  };

  try {
    const orientation = await detectOrientation(fileList[0]);
    
    // Define target based on first video
    const target = orientation === "portrait" 
      ? { w: 720, h: 1280 } 
      : { w: 1280, h: 720 };

    let clipsToStitch = [];

    if (orientation === "portrait") {
      console.log("📱 PORTRAIT detected. Normalizing with Blur-Padding...");
      
      // We normalize both to be safe, or just n2 as per your requirement
      // Using your existing normalizeClip (The one with blurred background)
      await normalizeClip(fileList[1], tempFiles.n2, target);
      
      if (metadata.shopLogo) {
        await createOutro(metadata.shopLogo, tempFiles.outro, target);
        clipsToStitch = [fileList[0], tempFiles.n2, tempFiles.outro];
      } else {
        clipsToStitch = [fileList[0], tempFiles.n2];
      }

    } else {
      console.log("🌅 LANDSCAPE detected. Normalizing with Scale-Only (Letterbox)...");
      
      // Run a "Light" normalization for Landscape to ensure matching resolutions
      // This prevents the stitch from failing if fileList[0] is 1080p and fileList[1] is 720p
      await scaleOnlyNormalize(fileList[0], tempFiles.n1, target);
      await scaleOnlyNormalize(fileList[1], tempFiles.n2, target);

      if (metadata.shopLogo) {
        await createOutro(metadata.shopLogo, tempFiles.outro, target);
        clipsToStitch = [tempFiles.n1, tempFiles.n2, tempFiles.outro];
      } else {
        clipsToStitch = [tempFiles.n1, tempFiles.n2];
      }
    }

    console.log(`🎬 Final Step: Stitching ${clipsToStitch.length} clips...`);
    await stitchClips(clipsToStitch, outputPath);

  } catch (error) {
    console.error("❌ Stitching Error:", error);
    throw error;
  } finally {
    for (const file of Object.values(tempFiles)) {
      try { if (fs.existsSync(file)) await fs.unlink(file); } catch (e) { /* ignore */ }
    }
  }
};

/**
 * Lightweight normalization for Landscape
 * Just scales and pads with black bars if ratios don't match perfectly
 */
const scaleOnlyNormalize = (input, output, target) => {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .videoFilters([
        `scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease`,
        `pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2`,
        "format=yuv420p"
      ])
      .outputOptions(["-c:v libx264", "-preset superfast", "-crf 23", "-c:a copy"])
      .on("end", () => resolve(output))
      .on("error", reject)
      .save(output);
  });
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
/* NORMALIZATION WITH BLUR PADDING  */
/* -------------------------------- */

const normalizeClip = (input, output, target) => {
  const { w, h } = target;

  return new Promise((resolve, reject) => {

    const filter = `
      [0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,
      boxblur=20:10,
      crop=${w}:${h}[bg];
      [0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];
      [bg][fg]overlay=(W-w)/2:(H-h)/2,
      fps=30,settb=AVTB,format=yuv420p
    `;

    ffmpeg(input)
      .complexFilter(filter)
      .audioFilters("aformat=sample_rates=44100:channel_layouts=stereo")
      .outputOptions([
        "-preset fast",
        "-c:v libx264",
        "-c:a aac",
        "-threads 8"
      ])
      .on("end", () => resolve(output))
      .on("error", reject)
      .save(output);
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
    const textMoveX = `if(lt(t,${slideTime}),-w+(t/${slideTime})*(w+(w-text_w)/2),if(gt(t,${duration-slideTime}),(w-text_w)/2+((t-(${duration-slideTime}))/${slideTime})*w,(w-text_w)/2))`;

    const titleText = title.toUpperCase().replace(/'/g, "\u2019");
    const subtitleText = subtitle.replace(/'/g, "\u2019");

    const filterString = [
      // Static drawboxes — no dynamic x expression
      `drawbox=x=${centerX}:y=${h/2-80}:w=${iw_val}:h=160:color=black@0.4:t=fill:enable='between(t,0,${duration})'`,
      `drawbox=x=${centerX}:y=${h/2-55}:w=${iw_val}:h=3:color=white@0.8:t=fill:enable='between(t,0,${duration})'`,
      `drawbox=x=${centerX}:y=${h/2+25}:w=${iw_val}:h=3:color=white@0.8:t=fill:enable='between(t,0,${duration})'`,
      // Sliding text still works fine
      `drawtext=text='${titleText}':fontfile=${fontPath}:fontsize=56:fontcolor=white:borderw=1:bordercolor=white:x=${textMoveX}:y=${h/2-40}:enable='between(t,0,${duration})'`,
      `drawtext=text='${subtitleText}':fontfile=${fontPath}:fontsize=24:fontcolor=white:borderw=1:bordercolor=white:x=${textMoveX}:y=${h/2+35}:enable='between(t,0,${duration})'`
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
    const videoFilter = `
      [0:v]loop=loop=-1:size=1:start=0,
      scale=${w}:${h}:force_original_aspect_ratio=increase,
      boxblur=20:10,
      crop=${w}:${h},
      trim=duration=2,
      format=yuv420p[vout]
    `;

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
/* STITCH WITH TRANSITIONS          */
/* -------------------------------- */

const stitchClips = (clips, output) => {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    clips.forEach(c => command.input(c));

    // Concatenate exactly 1 video and 1 audio stream from each input
    command
      .complexFilter([
        `concat=n=${clips.length}:v=1:a=1 [v] [a]`
      ])
      .map("[v]")
      .map("[a]")
      .outputOptions([
        "-c:v libx264",
        "-preset medium",
        "-c:a aac",
        "-movflags +faststart"
      ])
      .on("end", () => {
        console.log("🎬 Final stitching complete");
        resolve(output);
      })
      .on("error", (err) => {
        console.error("❌ Stitching error:", err);
        reject(err);
      })
      .save(output);
  });
};
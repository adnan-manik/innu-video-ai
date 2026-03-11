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
  // Unique ID to prevent file collisions in Cloud Run's shared /tmp
  const id = Date.now() + "_" + Math.floor(Math.random() * 1000);
  const tmp = (name) => path.join(os.tmpdir(), `${id}_${name}`);

  const tempFiles = {
    n1: tmp("n1.mp4"),
    n2: tmp("n2.mp4"),
    intro: tmp("intro_stage.mp4"),
    outro: tmp("outro_stage.mp4")
  };

  try {
    const orientation = await detectOrientation(fileList[0]);
    const target = orientation === "portrait" ? { w: 720, h: 1280 } : { w: 1280, h: 720 };

    // Use absolute /tmp paths for normalization
    await normalizeClip(fileList[0], tempFiles.n1, target); // fileList[0] is raw video
    await normalizeClip(fileList[1], tempFiles.n2, target); // fileList[1] is edu video

    console.log("✅ Clips normalized in /tmp");

    await addIntroText(
      tempFiles.n1,
      tempFiles.intro,
      metadata.vehicleName,
      metadata.shopName,
      target
    );

    console.log("✅ Intro added");
    const logoPath = path.join("/video-app", metadata.shopLogo);
  
    await createOutro(logoPath, tempFiles.outro, target); // fileList[3] is outro image

    console.log("✅ Outro created");

    // Final stitch combines the newly created intro, the normalized edu clip, and outro
    await stitchClips(
      [tempFiles.intro, tempFiles.n2, tempFiles.outro],
      outputPath
    );

    console.log("✅ Final video created");

  } catch (error) {
    console.error("❌ Stitching Error:", error);
    throw error;
  } finally {
    // Delete only intermediate files, leaving the final outputPath
    for (const file of Object.values(tempFiles)) {
      try {
        await fs.unlink(file);
      } catch (e) { /* ignore */ }
    }
    console.log("🧹 Intermediate tmp files deleted");
  }
};

/* -------------------------------- */
/* ORIENTATION DETECTION            */
/* -------------------------------- */

const detectOrientation = (file) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);

      const stream = data.streams.find(s => s.width);

      resolve(stream.height > stream.width ? "portrait" : "landscape");
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
        "-c:a aac"
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
    const iw_val = w < h ? w : w / 1.2;

    // Relative path is safer on Windows to avoid the "C\:" drive letter crash
    const fontPath = 'font.ttf'; 

    const duration = 3;
    const slideTime = 0.5;

    // 3. TEXT MOVEMENT: Anchored to the center of the frame
    const textMoveX = `if(lt(t,${slideTime}), -w+(t/${slideTime})*(w+(w-text_w)/2), if(gt(t,${duration-slideTime}), (w-text_w)/2+((t-(${duration-slideTime}))/${slideTime})*w, (w-text_w)/2))`;
    ffmpeg(input)
      .videoFilters([
        // 1. BLACK BACKGROUND BAR
        {
          filter: "drawbox",
          options: {
            y: `${h / 2 - 80}`,
            w: `${iw_val}`, h: 160,
            color: "black@0.4", t: "fill",
            enable: `between(t,0,${duration})`
          }
        },
        // 2. TOP WHITE LINE
        {
          filter: "drawbox",
          options: {
            y: `${h / 2 - 55}`,
            w: `${iw_val}`, h: 3,
            color: "white@0.8", t: "fill",
            enable: `between(t,0,${duration})`
          }
        },
        // 3. BOTTOM WHITE LINE
        {
          filter: "drawbox",
          options: {
            y: `${h / 2 + 25}`,
            w: `${iw_val}`, h: 3,
            color: "white@0.8", t: "fill",
            enable: `between(t,0,${duration})`
          }
        },
        // 4. VEHICLE NAME (Sliding Text)
        {
          filter: "drawtext",
          options: {
            text: title.toUpperCase(),
            fontfile: fontPath,
            fontsize: 56,
            fontcolor: "white",
            borderw: 1,
            bordercolor: "white",
            x: textMoveX,
            y: `${h / 2 - 40}`,
            enable: `between(t,0,${duration})`
          }
        },
        // 5. SHOP NAME (Sliding Text)
        {
          filter: "drawtext",
          options: {
            text: subtitle,
            fontfile: fontPath,
            fontsize: 24,
            fontcolor: "white",
            borderw: 1,
            bordercolor: "white",
            x: textMoveX,
            y: `${h / 2 + 35}`,
            enable: `between(t,0,${duration})`
          }
        }
      ])
      .outputOptions(["-c:v libx264", "-preset veryfast", "-c:a copy"])
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
    const filter = `
      [0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,
      boxblur=20:10,
      crop=${w}:${h}[bg];
      [0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];
      [bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[vout];
      [1:a]aformat=sample_rates=44100:channel_layouts=stereo[aout]
    `;

    ffmpeg()
      .input(image)
      .input('anullsrc=channel_layout=stereo:sample_rate=44100') // silent audio
      .inputFormat('lavfi')
      .duration(2)
      .complexFilter(filter)
      .map('[vout]')
      .map('[aout]')
      .outputOptions([
        "-c:v libx264",
        "-c:a aac",
        "-movflags +faststart"
      ])
      .on("end", () => resolve(output))
      .on("error", reject)
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
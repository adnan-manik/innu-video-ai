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
    outro: tmp("outro_stage.mp4")
  };

  try {
    // 1. Detect Orientation & Hardware Specs
    const orientation = await detectOrientation(fileList[0]);
    const target = orientation === "portrait" ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
    const { w, h } = target;

    // 2. Pre-flight: Check for audio streams to prevent "Stream not found" errors
    const checkAudio = async (file) => {
      const probe = await new Promise((res) => ffmpeg.ffprobe(file, (err, data) => res(data || {})));
      return probe.streams?.some(s => s.codec_type === 'audio') || false;
    };

    const hasAudio0 = await checkAudio(fileList[0]);
    const hasAudio1 = await checkAudio(fileList[1]);

    // 3. Create Outro (Always generated with audio in our previous logic)
    if (metadata.shopLogo) {
      await createOutro(metadata.shopLogo, tempFiles.outro, target);
    }

    const hasOutro = fs.existsSync(tempFiles.outro);
    const command = ffmpeg();
    fileList.forEach(file => command.input(file));
    if (hasOutro) command.input(tempFiles.outro);

    // 4. Build Mega-Filter with Audio Insurance
    // If no audio exists, we use 'anullsrc' to generate a silent placeholder
    const a0Source = hasAudio0 ? `[0:a]` : `anullsrc=r=44100:cl=stereo,trim=duration=5[a0_dummy];[a0_dummy]`;
    const a1Source = hasAudio1 ? `[1:a]` : `anullsrc=r=44100:cl=stereo,trim=duration=5[a1_dummy];[a1_dummy]`;

    const filter = [
      // Clip 1: Normalize & Audio Fix
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,boxblur=20:10,crop=${w}:${h}[bg1]`,
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg1]`,
      `[bg1][fg1]overlay=(W-w)/2:(H-h)/2,fps=30,setsar=1[v1]`,
      `${a0Source}aresample=async=1,aformat=sample_rates=44100:channel_layouts=stereo[a1]`,

      // Clip 2: Normalize & Audio Fix
      `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,boxblur=20:10,crop=${w}:${h}[bg2]`,
      `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg2]`,
      `[bg2][fg2]overlay=(W-w)/2:(H-h)/2,fps=30,setsar=1[v2]`,
      `${a1Source}aresample=async=1,aformat=sample_rates=44100:channel_layouts=stereo[a2]`,

      // Outro Handling & Final Concat
      hasOutro 
        ? `[2:v]fps=30,setsar=1[v3];[2:a]aformat=sample_rates=44100:channel_layouts=stereo[a3];[v1][a1][v2][a2][v3][a3]concat=n=3:v=1:a=1[v][a]`
        : `[v1][a1][v2][a2]concat=n=2:v=1:a=1[v][a]`
    ].join(';');

    await new Promise((resolve, reject) => {
      command
        .complexFilter(filter)
        .map('[v]')
        .map('[a]')
        .outputOptions([
          "-c:v libx264",
          "-preset superfast",
          "-crf 23",
          "-c:a aac",
          "-b:a 128k",
          "-movflags +faststart"
        ])
        .on("error", (err, stdout, stderr) => {
          console.error("❌ FFmpeg Mega-Stitch Error:", stderr);
          reject(err);
        })
        .on("end", resolve)
        .save(outputPath);
    });

    console.log("✅ Video Stitched Successfully with Audio Insurance");

  } catch (error) {
    console.error("❌ Critical Failure in Sequence:", error);
    throw error;
  } finally {
    if (fs.existsSync(tempFiles.outro)) await fs.unlink(tempFiles.outro);
    console.log("🧹 Cleanup complete");
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
/* NORMALIZATION WITH BLUR PADDING  */
/* -------------------------------- */

const normalizeClip = (input, output, target) => {
  const { w, h } = target;

  return new Promise((resolve, reject) => {
    // 1. Probe the input to determine its orientation
    ffmpeg.ffprobe(input, (err, metadata) => {
      if (err) return reject(err);

      const stream = metadata.streams.find(s => s.codec_type === 'video');
      if (!stream) return reject(new Error("No video stream found"));

      // Handle metadata rotation (essential for phone videos)
      let rotation = 0;
      if (stream.side_data_list) {
        const sideData = stream.side_data_list.find(sd => sd.rotation !== undefined);
        if (sideData) rotation = Math.abs(sideData.rotation);
      }
      
      const isRotated = rotation === 90 || rotation === 270;
      const inputW = isRotated ? stream.height : stream.width;
      const inputH = isRotated ? stream.width : stream.height;

      const inputIsPortrait = inputH > inputW;
      const targetIsPortrait = h > w;

      let filter;

      // 2. Build Filter based on Orientation Match
      if (inputIsPortrait === targetIsPortrait) {
        // MATCH: Simple scale and pad (Letterbox/Pillarbox)
        console.log(`✅ Orientation Match: Scaling to ${w}x${h}`);
        filter = `
          [0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,
          pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,
          fps=30,settb=AVTB,format=yuv420p
        `;
      } else {
        // MISMATCH: Add Blur Padding
        console.log(`⚠️ Orientation Mismatch: Adding Blur Padding`);
        filter = `
          [0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,
          boxblur=20:10,
          crop=${w}:${h}[bg];
          [0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];
          [bg][fg]overlay=(W-w)/2:(H-h)/2,
          fps=30,settb=AVTB,format=yuv420p
        `;
      }

      // 3. Execute FFmpeg
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

    // ── Generate Input References ─────────────────────────────────────────────
    // This creates a string like "[0:v][0:a][1:v][1:a][2:v][2:a]"
    const inputRefs = clips.map((_, i) => `[${i}:v][${i}:a]`).join('');

    command
      .complexFilter([
        `${inputRefs} concat=n=${clips.length}:v=1:a=1 [v] [a]`
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
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
    const folder = path.dirname(outputPath);
    const filename = path.basename(outputPath);

    ffmpeg(inputPath)
      .screenshots({
        timestamps: [3],
        filename: filename,
        folder: folder,
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
/* MERGED PROCESSING FUNCTION       */
/* -------------------------------- */
const processVideosMerged = async (input1, input2, output, target, metadata) => {
  return new Promise((resolve, reject) => {
    const { w, h } = target;
    const fontPath = './font.ttf';

    // Base filter for normalizing videos with blur padding
    const normalizeFilter = (inputIndex) => `
      [${inputIndex}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,
      boxblur=20:10,
      crop=${w}:${h}[bg${inputIndex}];
      [${inputIndex}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg${inputIndex}];
      [bg${inputIndex}][fg${inputIndex}]overlay=(W-w)/2:(H-h)/2,
      fps=30,settb=AVTB,format=yuv420p[clip${inputIndex}]
    `;

    // Intro text overlay (if needed)
    const introFilter = metadata.vehicleName && metadata.shopName ? `
      [intro]drawbox=x=${Math.floor((w - w/1.2)/2)}:y=${h/2-80}:w=${w/1.2}:h=160:color=black@0.4:t=fill:enable='between(t,0,3)',
      drawbox=x=${Math.floor((w - w/1.2)/2)}:y=${h/2-55}:w=${w/1.2}:h=3:color=white@0.8:t=fill:enable='between(t,0,3)',
      drawbox=x=${Math.floor((w - w/1.2)/2)}:y=${h/2+25}:w=${w/1.2}:h=3:color=white@0.8:t=fill:enable='between(t,0,3)',
      drawtext=text='${metadata.vehicleName.toUpperCase().replace(/'/g, "\u2019")}':
        fontfile=${fontPath}:fontsize=56:fontcolor=white:borderw=1:bordercolor=white:
        x='if(lt(t,0.5),-w+(t/0.5)*(w+(w-text_w)/2),if(gt(t,2.5),(w-text_w)/2+((t-2.5)/0.5)*w,(w-text_w)/2))':
        y=${h/2-40}:enable='between(t,0,3)',
      drawtext=text='${metadata.shopName.replace(/'/g, "\u2019")}':
        fontfile=${fontPath}:fontsize=24:fontcolor=white:borderw=1:bordercolor=white:
        x='if(lt(t,0.5),-w+(t/0.5)*(w+(w-text_w)/2),if(gt(t,2.5),(w-text_w)/2+((t-2.5)/0.5)*w,(w-text_w)/2))':
        y=${h/2+35}:enable='between(t,0,3)'[intro_final]
    ` : null;

    // Build the complete filtergraph
    let filterComplex = [
      normalizeFilter(0),
      normalizeFilter(1)
    ];

    // Add concat for video and audio
    const concatParts = ['[clip0]', '[clip1]'];
    let mapCommands = ['-map', '[vout]', '-map', '[aout]'];

    if (introFilter) {
      filterComplex.push(introFilter);
      filterComplex.push(`[clip0]split[clip0_main][clip0_intro]`);
      filterComplex.push(`[clip0_intro]trim=duration=3[intro_clip]`);
      filterComplex.push(`[intro_clip]${introFilter}[intro_final]`);
      filterComplex.push(`[intro_final][clip0_main]concat=n=2:v=1:a=1[intro_concat]`);
      concatParts.unshift('[intro_concat]');
    }

    // Final concat for all video streams
    filterComplex.push(`${concatParts.join('')}concat=n=${concatParts.length}:v=1:a=1[vout][aout]`);

    // Build the FFmpeg command
    let command = ffmpeg()
      .input(input1)
      .input(input2)
      .complexFilter(filterComplex.join(';'))
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-threads', '8'
      ])
      .on('end', () => {
        console.log('✅ Merged processing complete');
        resolve(output);
      })
      .on('error', (err) => {
        console.error('❌ Merged processing error:', err);
        reject(err);
      })
      .save(output);

    console.log('🚀 FFmpeg Command:', command._getArguments().join(' '));
  });
};

/* -------------------------------- */
/* OUTRO FUNCTION (SEPARATE)        */
/* -------------------------------- */
export const createOutro = async (image, outputPath, target) => {
  const { w, h } = target;

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(image)
      .complexFilter([
        `[0:v]loop=loop=-1:size=1:start=0,
        scale=${w}:${h}:force_original_aspect_ratio=increase,
        boxblur=20:10,
        crop=${w}:${h},
        trim=duration=2,
        format=yuv420p[vout]`,
        `aevalsrc=0:c=stereo:s=44100:d=2[aout]`
      ].join(';'))
      .map('[vout]')
      .map('[aout]')
      .outputOptions([
        '-t', '2',
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-preset', 'fast'
      ])
      .on('end', () => {
        console.log(`✅ Outro created: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('❌ Outro creation error:', err);
        reject(err);
      })
      .save(outputPath);
  });
};

/* -------------------------------- */
/* MAIN STITCHING FUNCTION          */
/* -------------------------------- */
export const stitchDynamicSequence = async (fileList, outputPath, metadata) => {
  const id = Date.now() + "_" + Math.floor(Math.random() * 1000);
  const tmp = (name) => path.join(os.tmpdir(), `${id}_${name}`);

  const tempFiles = {
    finalWithoutOutro: tmp("final_without_outro.mp4"),
    outro: tmp("outro.mp4")
  };

  try {
    // Detect orientation from first video
    const orientation = await detectOrientation(fileList[0]);
    const target = orientation === "portrait" ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
    console.log(`📐 Detected orientation: ${orientation}`);

    // Process both videos in a single FFmpeg command
    await processVideosMerged(
      fileList[0],
      fileList[1],
      tempFiles.finalWithoutOutro,
      target,
      metadata
    );

    // Create outro separately if shopLogo exists
    if (metadata.shopLogo) {
      await createOutro(metadata.shopLogo, tempFiles.outro, target);
      
      // Simple concat of main video and outro
      await simpleConcat([tempFiles.finalWithoutOutro, tempFiles.outro], outputPath);
      console.log("✅ Final video with outro created");
    } else {
      // Just copy the processed video to final output
      await fs.copyFile(tempFiles.finalWithoutOutro, outputPath);
      console.log("✅ Final video created (no outro)");
    }

  } catch (error) {
    console.error("❌ Stitching Error:", error);
    throw error;
  } finally {
    // Cleanup temp files
    for (const file of Object.values(tempFiles)) {
      try { await fs.unlink(file); } catch (e) { /* ignore */ }
    }
    console.log("🧹 Temp files deleted");
  }
};

/* -------------------------------- */
/* SIMPLE CONCAT FUNCTION           */
/* -------------------------------- */
const simpleConcat = async (clips, output) => {
  const id = Date.now();
  const listFile = path.join(os.tmpdir(), `${id}_concat.txt`);
  
  const content = clips.map(c => `file '${c}'`).join('\n');
  await fs.writeFile(listFile, content);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-threads', '8'
      ])
      .on("end", async () => {
        await fs.unlink(listFile).catch(() => {});
        console.log("🎬 Final stitching complete");
        resolve(output);
      })
      .on("error", async (err) => {
        await fs.unlink(listFile).catch(() => {});
        console.error("❌ Stitching error:", err);
        reject(err);
      })
      .save(output);
  });
};

// Keep the original function exports for backward compatibility
export { extractFrame as extractFrame };
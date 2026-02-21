import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

// 🎞️ Helper: Extract Single Frame from Video
export const extractFrame = (videoPath, outputPath) => {
  return new Promise((resolve, reject) => {

    const folder = path.dirname(outputPath);
    const filename = path.basename(outputPath);

    ffmpeg(videoPath)
      .screenshots({
        count: 1,
        folder: folder,      
        filename: filename, 
        timemarks: ['50%'],
        size: '1280x720'
      })
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err));
  });
};

// ⚡ Helper: Stitch Videos Dynamically (with Smart Compression)
export const stitchDynamicSequence = (fileList, outputPath) => {
  return new Promise((resolve, reject) => {
    if (fileList.length === 0) return reject(new Error("No files provided for stitching."));
    
    // 1. Calculate Total Input Size in MB
    let totalSizeInMB = 0;
    try {
      const totalBytes = fileList.reduce((acc, file) => acc + fs.statSync(file).size, 0);
      totalSizeInMB = totalBytes / (1024 * 1024);
      console.log(`📊 Total Input Size: ${totalSizeInMB.toFixed(2)} MB`);
    } catch (err) {
      console.warn("⚠️ Could not read file sizes. Defaulting to Size Priority.");
      totalSizeInMB = 150; // Fallback to heavy compression if fs fails
    }

    // 2. Define Output Options dynamically based on your logic
    let outputOptions = [
      '-map [v]', 
      '-map [a]',
      '-c:v libx264',
      '-movflags +faststart', // Essential for fast web playback
      '-shortest'             // Stop encoding when the shortest stream ends
    ];

    if (totalSizeInMB < 95) {
      // ✨ < 100MB: Prioritize QUALITY and SPEED
      console.log(" < 100MB: Prioritizing Quality & Speed (Superfast/CRF23)");
      outputOptions.push(
        '-preset superfast',   // Highest speed (sacrifices compression efficiency, but we don't care here)
        '-crf 23',             // High visual quality
        '-c:a aac',            // Compress audio
        '-b:a 128k'            // Good audio quality
      );
    } else {
      // 🗜️ >= 100MB: Prioritize SIZE and BALANCE (Speed/Quality)
      console.log(" >= 100MB: Prioritizing Size (Fast/CRF28/Maxrate)");
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
        return `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}];[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`;
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
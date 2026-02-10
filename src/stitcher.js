import ffmpeg from 'fluent-ffmpeg';
import path from 'path';

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
        timemarks: ['30%'],
        size: '1280x720'
      })
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err));
  });
};

// ⚡ Helper: Stitch Videos Together Dynamically
export const stitchDynamicSequence = (fileList, outputPath) => {
  return new Promise((resolve, reject) => {
    if (fileList.length === 0) return reject(new Error("No files"));
    
    const command = ffmpeg();
    fileList.forEach(file => command.input(file));

    // Standardize: 720p, 30fps, YUV420p (Safe for all web players)
    const filterComplex = fileList.map((_, i) => {
        return `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}];[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`;
    }).join(';');

    const inputStreams = fileList.map((_, i) => `[v${i}][a${i}]`).join('');

    command
      .complexFilter(`${filterComplex};${inputStreams}concat=n=${fileList.length}:v=1:a=1[v][a]`)
      .outputOptions([
          '-map [v]', 
          '-map [a]',
          '-c:v libx264',
          '-preset ultrafast',  
          '-crf 28',            
          '-movflags +faststart', 
          '-shortest'
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err, stdout, stderr) => {
          console.error("FFmpeg Error:", stderr);
          reject(err);
      })
      .run();
  });
};
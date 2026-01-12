import ffmpeg from 'fluent-ffmpeg';

export const stitchDynamicSequence = (fileList, outputPath) => {
  return new Promise((resolve, reject) => {
    if (fileList.length === 0) return reject(new Error("No files"));
    
    const command = ffmpeg();
    fileList.forEach(file => command.input(file));

    // Scale all inputs to 1280x720 to prevent resolution mismatch errors
    const filterComplex = fileList.map((_, i) => 
      `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`
    ).join(';');

    const inputStreams = fileList.map((_, i) => `[v${i}][a${i}]`).join('');

    command
      .complexFilter(`${filterComplex};${inputStreams}concat=n=${fileList.length}:v=1:a=1[v][a]`)
      .outputOptions(['-map [v]', '-map [a]'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
};
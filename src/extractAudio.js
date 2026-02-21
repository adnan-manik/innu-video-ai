import ffmpeg from 'fluent-ffmpeg';

export const extractAudio = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    console.log(`🎵 Extracting audio for Whisper from: ${inputPath}`);

    ffmpeg(inputPath)
      .noVideo()                     // Drop the video stream entirely
      // --- Whisper MP3 Optimizations ---
      .audioCodec('libmp3lame')      // Standard MP3 codec (Officially supported)
      .audioChannels(1)              // Downmix to Mono (cuts size in half)
      .audioFrequency(16000)         // 16kHz (Whisper's native processing rate)
      .audioBitrate('32k')           // 32 kbps (Tiny file size, perfect for speech)
      // ---------------------------------
      .on('start', () => {
        console.log('⏳ Started FFmpeg extraction...');
      })
      .on('error', (err) => {
        console.error('❌ FFmpeg Error:', err.message);
        reject(err);
      })
      .on('end', () => {
        console.log(`✅ Audio extracted successfully: ${outputPath}`);
        resolve(outputPath);
      })
      .save(outputPath);
  });
};
import express from 'express';
import dotenv from 'dotenv';
import { processVideoJob, processReStitchJob } from './processor.js';
dotenv.config();

const app = express();
app.use(express.json());

app.post('/', async (req, res) => {
  if (!req.body) {
    const msg = 'no Pub/Sub message received';
    console.error(`error: ${msg}`);
    res.status(400).send(`Bad Request: ${msg}`);
    return;
  }

  if (!req.body.message) {
    const msg = 'invalid Pub/Sub message format';
    console.error(`error: ${msg}`);
    res.status(400).send(`Bad Request: ${msg}`);
    return;
  }

  // Decode the data
  const pubSubMessage = req.body.message;
  const data = pubSubMessage.data
    ? Buffer.from(pubSubMessage.data, 'base64').toString().trim()
    : '{}';

  try {
    const event = JSON.parse(data);

    let eventType = 'Unknown';
    
    if (event.type === 'RE_STITCH') {
        eventType = 'RE_STITCH';
    } else if (event.kind === 'storage#object' || event.name) {
        // If it has a 'name' (filepath) or 'kind', it's a file upload
        eventType = 'FILE_UPLOAD'; 
    }

    console.log(`🧐 Event Type Detected: ${eventType}`);

    // Ack immediately
    res.status(200).send('Ack');

    // Route the logic
    if (eventType === 'RE_STITCH') {
      console.log("♻️ Routing to Re-Stitcher...");
      await processReStitchJob(event.videoId);
    } else if (eventType === 'FILE_UPLOAD') {
      console.log(`📂 Routing to Video Processor: ${event.name}`);
      await processVideoJob(event);
    } else {
      console.warn("⚠️ Event ignored: Unknown structure");
    }
  } catch (e) {
    console.error("💥 JSON Parse Error:", e);
    res.status(200).send('Ack'); 
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Worker listening on ${PORT}`));
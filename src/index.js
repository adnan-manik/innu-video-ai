import express from 'express';
import dotenv from 'dotenv';
import { processVideoJob, processReStitchJob } from './processor.js';
dotenv.config();

const app = express();
app.use(express.json());

// app.post('/', async (req, res) => {
//   if (!req.body.message) return res.status(400).send('No message');

//   const data = Buffer.from(req.body.message.data, 'base64').toString().trim();
  
//   try {
//     const event = JSON.parse(data);
//     res.status(200).send('Ack'); // Ack immediately

//     if (event.type === 'RE_STITCH') {
//       await processReStitchJob(event.videoId);
//     } else {
//       // Default: File Upload Event
//       await processVideoJob(event);
//     }
//   } catch (e) {
//     console.error(e);
//     res.status(200).send('Ack'); // Prevent infinite retries on bad JSON
//   }
// });


app.post('/', async (req, res) => {
  if (!req.body) {
    const msg = 'no Pub/Sub message received';
    console.error(`error: ${msg}`);
    res.status(400).send(`Bad Request: ${msg}`);
    return;
  }

  // 1. LOG THE RAW BODY (This will reveal the issue)
  console.log("📨 Raw Pub/Sub Body:", JSON.stringify(req.body, null, 2));

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

  // 2. LOG THE DECODED DATA
  console.log("🔓 Decoded Data:", data);

  try {
    const event = JSON.parse(data);

    // 3. LOG THE EVENT TYPE
    console.log("🧐 Event Type Detected:", event.type || "Unknown");

    // Ack immediately to prevent Pub/Sub retries
    res.status(200).send('Ack');

    // Route the logic
    if (event.type === 'RE_STITCH') {
      await processReStitchJob(event.videoId);
    } else {
      // Default: Assume it's a file upload event from Storage
      await processVideoJob(event);
    }
  } catch (e) {
    console.error("💥 JSON Parse Error:", e);
    // Still send 200 so Pub/Sub doesn't retry a bad message forever
    res.status(200).send('Ack'); 
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Worker listening on ${PORT}`));
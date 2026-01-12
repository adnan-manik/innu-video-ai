import express from 'express';
import dotenv from 'dotenv';
import { processVideoJob, processReStitchJob } from './processor.js';
dotenv.config();

const app = express();
app.use(express.json());

app.post('/', async (req, res) => {
  if (!req.body.message) return res.status(400).send('No message');

  const data = Buffer.from(req.body.message.data, 'base64').toString().trim();
  
  try {
    const event = JSON.parse(data);
    res.status(200).send('Ack'); // Ack immediately

    if (event.type === 'RE_STITCH') {
      await processReStitchJob(event.videoId);
    } else {
      // Default: File Upload Event
      await processVideoJob(event);
    }
  } catch (e) {
    console.error(e);
    res.status(200).send('Ack'); // Prevent infinite retries on bad JSON
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Worker listening on ${PORT}`));
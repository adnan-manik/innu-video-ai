import OpenAI from 'openai';
import fs from 'fs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const transcribeAudio = async (filePath) => {
  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
    });
    return response.text;
  } catch (error) {
    console.error("❌ Transcription Failed:", error.message);
    return "";
  }
};

export const analyzeTranscription = async (transcriptionText) => {
  if (!transcriptionText) return { issues: [] };

  const systemPrompt = `
    You are an automotive expert. Analyze the transcription.
    Identify distinct mechanical problems.
    For EACH problem, list 3-5 keywords relevant to that specific issue.
    Return JSON format:
    {
      "issues": [
        { "problem": "Warped Rotors", "keywords": ["vibration", "brake pulsation"] },
        { "problem": "Oil Leak", "keywords": ["oil leak", "oil pan", "drip"] }
      ]
    }
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcriptionText }
      ]
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error("AI Error:", error);
    return { issues: [] };
  }
};
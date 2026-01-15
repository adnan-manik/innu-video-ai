import fs from 'fs';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const transcribeAudio = async (filePath) => {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
  });
  return transcription.text;
};

export const analyzeTranscriptionWithVision = async (transcriptionText, imagePath) => {
  // 1. Convert image to Base64
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  const systemPrompt = `
    You are a Master Automotive Technician.
    
    TASK:
    Analyze the mechanic's notes and visual evidence.
    Identify the mechanical problems.
    
    OUTPUT RULES:
    1. Identify the specific problem (e.g., "Warped Rotors").
    2. Identify the BROAD SYSTEM CATEGORY (Must be one of: "Brakes", "Cooling System", "Suspension", "Engine", "Exhaust", "Electrical", "Body").
    3. Return JSON format.

    JSON Structure:
    {
      "issues": [
        { 
          "problem": "Leaking Radiator Hose", 
          "category": "Cooling System",  // <--- NEW FIELD
          "keywords": ["Radiator Hose", "Coolant Leak"] 
        }
      ]
    }
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o", // Vision Model
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { 
          role: "user", 
          content: [
            { type: "text", text: `Transcription: ${transcriptionText}` },
            { 
              type: "image_url", 
              image_url: { url: `data:image/jpeg;base64,${base64Image}` } 
            }
          ] 
        }
      ]
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error("AI Error:", error);
    return { issues: [] }; // Fail gracefully
  }
};
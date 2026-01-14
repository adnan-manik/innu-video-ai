import db from './db.js'; // Ensure this path matches your project structure

export const findEducationalContent = async (aiAnalysis) => {
  const matches = [];
  const issues = aiAnalysis.issues || [];

  console.log("📚 Library Search: Looking for matches for:", JSON.stringify(issues));

  for (const issue of issues) {
    const aiKeywords = issue.keywords || [];
    
    // Safety check: skip if no keywords
    if (aiKeywords.length === 0) continue;

    const searchTerms = aiKeywords.map(k => `%${k}%`);

    try {
      const query = `
        SELECT id, title, video_url
        FROM educational_library
        WHERE is_active = true
        AND EXISTS (
          SELECT 1
          FROM unnest(keywords) as k
          WHERE k ILIKE ANY($1::text[])
        )
        LIMIT 1;
      `;

      const result = await db.query(query, [searchTerms]);
      
      if (result.rows.length > 0) {
        const video = result.rows[0];
        console.log(`✅ MATCH FOUND for "${issue.problem}": ${video.title}`);
        
        matches.push({
          problem: issue.problem,
          keywords: aiKeywords,
          library_id: video.id,
          video_url: video.video_url,
          title: video.title
        });
      } else {
        console.log(`⚠️ NO MATCH found in DB for "${issue.problem}" with keywords: ${JSON.stringify(aiKeywords)}`);
      }

    } catch (err) {
      console.error(`Library Query Error for ${issue.problem}:`, err);
    }
  }

  return matches;
};
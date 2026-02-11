import db from './db.js';

export const findEducationalContent = async (aiAnalysis) => {
  const matches = [];
  const issues = aiAnalysis.issues || [];
  
  // Track unique video IDs to see if multiple problems point to the same video
  const uniqueVideoIds = new Set();

  for (const issue of issues) {
    let videoMatch = null;

    // PHASE 1: SPECIFIC SEARCH
    const specificKeywords = issue.keywords || [];
    if (specificKeywords.length > 0) {
      const searchTerms = specificKeywords.map(k => `%${k}%`);
      try {
        const query = `
          SELECT id, title, video_url
          FROM educational_library
          WHERE is_active = true
          AND EXISTS (
            SELECT 1 FROM unnest(keywords) as k
            WHERE k ILIKE ANY($1::text[])
          ) AND category = $2
          LIMIT 1;
        `;
        const result = await db.query(query, [searchTerms, issue.category]);
        if (result.rows.length > 0) {
          videoMatch = result.rows[0];
        }
      } catch (e) { console.error("Search error", e); }
    }

    // PHASE 2: FALLBACK to Motovisuals/{category}/{category}
    // If no specific video found, create a match using the category path
    if (!videoMatch && issue.category) {
      console.log(`🛟 Falling back to Motovisuals path for category: ${issue.category}`);
      videoMatch = {
        id: `fallback_${issue.category}`,
        title: `${issue.category} Overview`,
        // Constructing the path as requested: Motovisuals/Category/Category
        video_url: `Motovisuals/${issue.category}/${issue.category}.mp4` 
      };
    }

    if (videoMatch) {
      uniqueVideoIds.add(videoMatch.video_url);
      matches.push({
        problem: issue.problem,
        category: issue.category,
        keywords: issue.keywords,
        library_id: videoMatch.id,
        video_url: videoMatch.video_url,
        title: videoMatch.title
      });
    }
  }

  // LOGIC: If multiple problems point to the EXACT SAME video URL, we treat it as one.
  // If they point to DIFFERENT videos, we must reject.
  if (uniqueVideoIds.size > 1) {
    throw new Error("FOCUS_LIMIT_EXCEEDED");
  }

  // Return only the first match (since they are all either the same or there is only one)
  return matches.length > 0 ? [matches[0]] : [];
};
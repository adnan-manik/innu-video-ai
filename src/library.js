import db from './db.js';

export const findEducationalContent = async (aiAnalysis) => {
  const matches = [];
  const issues = aiAnalysis.issues || [];

  for (const issue of issues) {
    let videoMatch = null;

    // PHASE 1: SPECIFIC SEARCH (High Precision)
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
                )
                LIMIT 1;
            `;
            const result = await db.query(query, [searchTerms]);
            if (result.rows.length > 0) {
                videoMatch = result.rows[0];
                console.log(`✅ EXACT MATCH: Found "${videoMatch.title}"`);
            }
        } catch (e) { console.error("Specific search error", e); }
    }

    // PHASE 2: FALLBACK SEARCH (Broad Category)
    // If specific search failed, look for the "General" video of that category
    if (!videoMatch && issue.category) {
        console.log(`No exact match. Attempting FALLBACK for category: ${issue.category}`);
        
        try {
            // We search for videos that have the 'Category' name AND 'General' or 'Overview'
            const fallbackTerms = [
                `%${issue.category}%`, // e.g. "%Cooling System%"
                '%General%',           // Look for generic terms
                '%Overview%'
            ];

            const fallbackQuery = `
                SELECT id, title, video_url
                FROM educational_library
                WHERE is_active = true
                AND (
                    title ILIKE ANY($1::text[]) OR
                    EXISTS (
                        SELECT 1 FROM unnest(keywords) as k
                        WHERE k ILIKE ANY($1::text[])
                    )
                )
                -- Prioritize videos with "General" or "Overview" in the title
                ORDER BY 
                    CASE WHEN title ILIKE '%General%' THEN 1 
                         WHEN title ILIKE '%Overview%' THEN 2 
                         ELSE 3 END ASC
                LIMIT 1;
            `;

            const result = await db.query(fallbackQuery, [fallbackTerms]);
            if (result.rows.length > 0) {
                videoMatch = result.rows[0];
                console.log(`🛟 FALLBACK MATCH: Found "${videoMatch.title}"`);
            }
        } catch (e) { console.error("Fallback search error", e); }
    }

    // SAVE RESULT
    if (videoMatch) {
        matches.push({
            problem: issue.problem,
            category: issue.category, 
            keywords: issue.keywords,
            library_id: videoMatch.id,
            video_url: videoMatch.video_url,
            title: videoMatch.title
        });
    } else {
        console.log(`NO MATCH (Specific or Fallback) for "${issue.problem}"`);
    }
  }
  
  return matches;
};
import db from './db.js';

export const findEducationalContent = async (aiResult) => {
  const matches = [];
  if (!aiResult || !aiResult.issues) return [];

  for (const issue of aiResult.issues) {
    const keywords = issue.keywords || [];
    if (keywords.length === 0) continue;

    try {
      const query = `
        SELECT id, title, video_url,
          (SELECT COUNT(*) FROM unnest(keywords) k WHERE k = ANY($1::text[])) as score
        FROM educational_library
        WHERE is_active = true
        ORDER BY score DESC LIMIT 1;
      `;
      const result = await db.query(query, [keywords]);
      const bestVid = result.rows[0];

      if (bestVid && parseInt(bestVid.score) > 0) {
        matches.push({
          problem: issue.problem,
          keywords: issue.keywords,
          library_id: bestVid.id,
          video_url: bestVid.video_url,
          title: bestVid.title
        });
      }
    } catch (err) {
      console.error(`Library search failed for ${issue.problem}`, err);
    }
  }
  return matches;
};
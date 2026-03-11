import db from './db.js';

export const findEducationalContent = async (aiAnalysis) => {
  const matches = [];
  const issues = aiAnalysis.issues || [];
  
  // Track unique video URLs and unique categories found
  const uniqueVideoUrls = new Set();
  const uniqueCategories = new Set();
  let specificMatchesCount = 0;

  for (const issue of issues) {
    let videoMatch = null;
    if (issue.category) uniqueCategories.add(issue.category);

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
          specificMatchesCount++;
        }
      } catch (e) { console.error("Search error", e); }
    }

    if (videoMatch) {
      uniqueVideoUrls.add(videoMatch.video_url);
      matches.push({
        problem: issue.problem,
        category: issue.category,
        keywords: issue.keywords,
        library_id: videoMatch.id,
        video_url: videoMatch.video_url,
        title: videoMatch.title
      });
    } else if (issue.category) {
      uniqueCategories.add(issue.category);
    }
  }

  // LOGIC 1: If issues span multiple DIFFERENT categories, reject immediately (Not related)
  if (uniqueCategories.size > 1) {
    throw new Error("FOCUS_LIMIT_EXCEEDED"); // All issues must be related to the same system
  }

  const primaryCategory = Array.from(uniqueCategories)[0];
  
  const needsOverview = 
    uniqueVideoUrls.size > 1 ||           // Multiple specific videos found
    specificMatchesCount < issues.length || // Some issues didn't have a specific match
    uniqueVideoUrls.size === 0;            // No matches found at all

  if (needsOverview && primaryCategory) {
    console.log(`🛟 Falling back to overview for: ${primaryCategory}`);
    return [{
      problem: "Multiple Issues Detected",
      category: primaryCategory,
      video_url: `Motovisuals/${primaryCategory}/${primaryCategory}.mp4`,
      title: `${primaryCategory} Overview`
    }];
  }

  // LOGIC 3: Return the single specific match if only one distinct video was found for all issues
  return matches.length > 0 ? [matches[0]] : [];
}
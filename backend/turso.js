const { createClient } = require('@libsql/client');

let tursoClient = null;

function getTursoClient() {
  if (tursoClient) return tursoClient;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    throw new Error(
      'Turso is not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.'
    );
  }

  tursoClient = createClient({ url, authToken });
  return tursoClient;
}

/**
 * Persist a scout search request into user_preferences for the Python worker.
 */
async function saveUserPreferences({
  searchJobId,
  regions,
  jobScopes,
  jobTitles,
  maxDatePublished,
  resumeText,
  resumeFileName,
  searchMode,
  jsearchQuery,
}) {
  const db = getTursoClient();

  await db.execute({
    sql: `
      INSERT INTO user_preferences (
        id,
        regions,
        job_scopes,
        job_titles,
        max_date_published,
        resume_text,
        resume_file_name,
        search_mode,
        jsearch_query,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `,
    args: [
      searchJobId,
      JSON.stringify(regions),
      JSON.stringify(jobScopes),
      JSON.stringify(jobTitles),
      maxDatePublished?.trim() || null,
      resumeText || '',
      resumeFileName || null,
      searchMode,
      jsearchQuery || '',
    ],
  });

  return { searchJobId, status: 'pending' };
}

async function getFoundJobsByPreferenceId(preferenceId) {
  const db = getTursoClient();
  const result = await db.execute({
    sql: `
      SELECT
        id,
        title,
        company,
        location,
        job_url,
        date_published,
        match_percentage,
        cover_letter
      FROM found_jobs
      WHERE preference_id = ?
      ORDER BY match_percentage DESC
    `,
    args: [preferenceId],
  });

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    company: row.company || 'Unknown company',
    location: row.location || '',
    datePublished: row.date_published || '',
    matchPercentage: row.match_percentage ?? null,
    applyLink: row.job_url,
    coverLetter: row.cover_letter || '',
    coverLetterUrl: '',
  }));
}

module.exports = {
  getTursoClient,
  saveUserPreferences,
  getFoundJobsByPreferenceId,
};

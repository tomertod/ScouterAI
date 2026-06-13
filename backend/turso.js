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

function requirePreferenceId(preferenceId, context) {
  const id = typeof preferenceId === 'string' ? preferenceId.trim() : '';
  if (!id) {
    throw new Error(
      `${context}: preferenceId is required (got ${String(preferenceId)})`
    );
  }
  return id;
}

/**
 * Persist a scout search request into user_preferences for the Python worker.
 * Returns the inserted row id as preferenceId for SearchQueue enqueueing.
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
  const preferenceId = requirePreferenceId(
    searchJobId,
    'saveUserPreferences'
  );
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
      preferenceId,
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

  return { preferenceId, status: 'pending' };
}

const LATEST_PREFERENCE_ID = 'latest';

/**
 * Persist the user's most recent search filters for automated worker runs (GitHub Actions).
 * Also mirrors into user_preferences so found_jobs FK stays valid.
 */
async function saveLatestUserPreferences({
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
  const args = [
    JSON.stringify(regions),
    JSON.stringify(jobScopes),
    JSON.stringify(jobTitles),
    maxDatePublished?.trim() || null,
    resumeText || '',
    resumeFileName || null,
    searchMode,
    jsearchQuery || '',
  ];

  await db.execute({
    sql: `
      INSERT INTO UserPreferences (
        id,
        regions,
        job_scopes,
        job_titles,
        max_date_published,
        resume_text,
        resume_file_name,
        search_mode,
        jsearch_query,
        updated_at
      ) VALUES ('latest', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        regions = excluded.regions,
        job_scopes = excluded.job_scopes,
        job_titles = excluded.job_titles,
        max_date_published = excluded.max_date_published,
        resume_text = excluded.resume_text,
        resume_file_name = excluded.resume_file_name,
        search_mode = excluded.search_mode,
        jsearch_query = excluded.jsearch_query,
        updated_at = datetime('now')
    `,
    args,
  });

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
        status,
        updated_at
      ) VALUES ('latest', ?, ?, ?, ?, ?, ?, ?, ?, 'saved', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        regions = excluded.regions,
        job_scopes = excluded.job_scopes,
        job_titles = excluded.job_titles,
        max_date_published = excluded.max_date_published,
        resume_text = excluded.resume_text,
        resume_file_name = excluded.resume_file_name,
        search_mode = excluded.search_mode,
        jsearch_query = excluded.jsearch_query,
        status = 'saved',
        updated_at = datetime('now')
    `,
    args,
  });

  return { preferenceId: LATEST_PREFERENCE_ID };
}

/**
 * Enqueue a search job for the Python worker (SearchQueue).
 * preferenceId must be the id returned from saveUserPreferences.
 */
async function enqueueSearchJob({ queueId, preferenceId }) {
  const prefId = requirePreferenceId(preferenceId, 'enqueueSearchJob');
  const id = requirePreferenceId(
    queueId || prefId,
    'enqueueSearchJob queueId'
  );
  const db = getTursoClient();

  await db.execute({
    sql: `
      CREATE TABLE IF NOT EXISTS SearchQueue (
        id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `,
  });

  await db.execute({
    sql: `
      INSERT INTO SearchQueue (id, preference_id, status)
      VALUES (?, ?, 'pending')
    `,
    args: [id, prefId],
  });

  return { queueId: id, preferenceId: prefId, status: 'pending' };
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
      LIMIT 5
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

async function getSearchResults(searchJobId) {
  const id = requirePreferenceId(searchJobId, 'getSearchResults');
  const db = getTursoClient();

  const prefResult = await db.execute({
    sql: `
      SELECT status
      FROM user_preferences
      WHERE id = ?
      LIMIT 1
    `,
    args: [id],
  });

  if (!prefResult.rows.length) {
    return null;
  }

  const status = prefResult.rows[0].status || 'pending';
  const jobs =
    status === 'completed' ? await getFoundJobsByPreferenceId(id) : [];

  return {
    searchJobId: id,
    status,
    jobs,
  };
}

module.exports = {
  getTursoClient,
  saveUserPreferences,
  saveLatestUserPreferences,
  enqueueSearchJob,
  getFoundJobsByPreferenceId,
  getSearchResults,
  LATEST_PREFERENCE_ID,
};

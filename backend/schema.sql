-- Turso / SQLite schema for ScouterAI

CREATE TABLE IF NOT EXISTS user_preferences (
  id TEXT PRIMARY KEY,
  regions TEXT NOT NULL DEFAULT '[]',
  job_scopes TEXT NOT NULL DEFAULT '[]',
  job_titles TEXT NOT NULL DEFAULT '[]',
  max_date_published TEXT,
  resume_text TEXT,
  resume_file_name TEXT,
  search_mode TEXT NOT NULL DEFAULT 'specific',
  jsearch_query TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS found_jobs (
  id TEXT PRIMARY KEY,
  preference_id TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  job_url TEXT NOT NULL UNIQUE,
  description TEXT,
  date_published TEXT,
  match_percentage REAL,
  cover_letter TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (preference_id) REFERENCES user_preferences(id)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_status ON user_preferences(status);
CREATE INDEX IF NOT EXISTS idx_found_jobs_preference_id ON found_jobs(preference_id);

-- Tracks Discord notifications already sent (dedupe by apply link)
CREATE TABLE IF NOT EXISTS SentJobs (
  apply_link TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Latest saved search preferences for automated daily worker runs
CREATE TABLE IF NOT EXISTS UserPreferences (
  id TEXT PRIMARY KEY DEFAULT 'latest',
  regions TEXT NOT NULL DEFAULT '[]',
  job_scopes TEXT NOT NULL DEFAULT '[]',
  job_titles TEXT NOT NULL DEFAULT '[]',
  max_date_published TEXT,
  resume_text TEXT,
  resume_file_name TEXT,
  search_mode TEXT NOT NULL DEFAULT 'specific',
  jsearch_query TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

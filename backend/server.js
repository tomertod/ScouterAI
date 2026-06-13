const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { spawn, execSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const locations = require('./locations');
const { saveUserPreferences, saveLatestUserPreferences, getFoundJobsByPreferenceId, getSearchResults } = require('./turso');

const PORT = 5001;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKER_SCRIPT_PATH = path.join(PROJECT_ROOT, 'worker.py');

function resolvePythonBin() {
  if (process.env.PYTHON_PATH) {
    return process.env.PYTHON_PATH;
  }
  if (process.platform === 'win32') {
    return 'python';
  }
  try {
    const resolved = execSync('which python3', { encoding: 'utf8' }).trim();
    return resolved.split(/\r?\n/)[0] || 'python3';
  } catch {
    return 'python3';
  }
}

const PYTHON_BIN = resolvePythonBin();
const MAKE_WEBHOOK_URL = 'https://hook.eu1.make.com/6q8qi3jvu9w1nav74h22dklbfunjkfem';
const MAX_JOBS = 5;
const MAKE_FETCH_TIMEOUT_MS = 120_000;
const SEARCH_JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** @type {Map<string, { status: string, jobs: Array, filters: object, createdAt: string, completedAt?: string, error?: string }>} */
const searchJobs = new Map();

/** @type {Map<string, Set<import('express').Response>>} */
const searchEventClients = new Map();

const VALID_REGION_CODES = new Set([
  'north',
  'haifa_krayot',
  'sharon',
  'center',
  'jerusalem',
  'south',
  'arava',
  'eilat',
]);

const REGION_SEARCH_TERMS = {
  north: 'Haifa North',
  haifa_krayot: 'Haifa Krayot',
  sharon: 'Sharon',
  center: 'Tel Aviv Center',
  jerusalem: 'Jerusalem',
  south: 'Beer Sheva South',
  arava: 'Arava',
  eilat: 'Eilat',
};

const JOB_SCOPE_SEARCH_TERMS = {
  'Full-time': 'full time',
  'Part-time': 'part time',
  Student: 'student',
  Internship: 'internship',
  Temporary: 'temporary contract',
};

const GENERAL_JOB_TITLE = 'General';
const GENERAL_JSEARCH_TERMS = [
  'Software Student Developer',
  'Computer Science Entry Level',
  'Junior Developer',
];

const REGION_CITY_POOLS = {
  north: ['Haifa', 'Nahariya', 'Tiberias', 'Tzfat', 'Acre', 'Kiryat Shmona'],
  haifa_krayot: ['Haifa', 'Kiryat Bialik', 'Kiryat Motzkin', 'Kiryat Yam', 'Nesher'],
  sharon: ['Netanya', 'Herzliya', 'Raanana', 'Hadera', 'Kfar Saba'],
  center: ['Tel Aviv', 'Ramat Gan', 'Rishon LeZion', 'Petah Tikva', 'Rehovot', 'Lod'],
  jerusalem: ['Jerusalem', 'Beit Shemesh', 'Maale Adumim', 'Mevaseret Zion'],
  south: ['Beer Sheva', 'Ashdod', 'Ashkelon', 'Sderot', 'Kiryat Gat'],
  arava: ['Yotvata', 'Ein Yahav', 'Sapir', 'Paran'],
  eilat: ['Eilat'],
};

const ALL_CITIES = [...new Set(Object.values(REGION_CITY_POOLS).flat())];

// Sync major Hebrew settlements from locations.js into display-aware pools
const HEBREW_TO_ENGLISH_CITY = {
  'תל אביב - יפו': 'Tel Aviv',
  'רמת גן': 'Ramat Gan',
  'ראשון לציון': 'Rishon LeZion',
  'פתח תקווה': 'Petah Tikva',
  'רחובות': 'Rehovot',
  'לוד': 'Lod',
  'נתניה': 'Netanya',
  'הרצליה': 'Herzliya',
  'רעננה': 'Raanana',
  'חדרה': 'Hadera',
  'כפר סבא': 'Kfar Saba',
  'חיפה': 'Haifa',
  'קרית ביאליק': 'Kiryat Bialik',
  'קרית מוצקין': 'Kiryat Motzkin',
  'קרית ים': 'Kiryat Yam',
  'נשר': 'Nesher',
  'נהריה': 'Nahariya',
  'טבריה': 'Tiberias',
  'צפת': 'Tzfat',
  'עכו': 'Acre',
  'קרית שמונה': 'Kiryat Shmona',
  'ירושלים': 'Jerusalem',
  'בית שמש': 'Beit Shemesh',
  'מעלה אדומים': 'Maale Adumim',
  'באר שבע': 'Beer Sheva',
  'אשדוד': 'Ashdod',
  'אשקלון': 'Ashkelon',
  'שדרות': 'Sderot',
  'קרית גת': 'Kiryat Gat',
  'אילת': 'Eilat',
  'יטבתה': 'Yotvata',
  'עין יהב': 'Ein Yahav',
  'ספיר': 'Sapir',
};

const settlementsByRegion = Object.values(locations).reduce((acc, code) => {
  acc[code] = acc[code] || [];
  return acc;
}, {});

for (const [settlement, code] of Object.entries(locations)) {
  if (!settlementsByRegion[code]) settlementsByRegion[code] = [];
  settlementsByRegion[code].push(settlement);
}

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF resumes are allowed'));
    }
  },
});

app.use(cors());
app.use(express.json());

function normalizeStringArray(body, key, validSet = null) {
  const raw = body[key];
  if (!raw) return [];

  const values = Array.isArray(raw) ? raw : [raw];

  const cleaned = [
    ...new Set(
      values
        .flatMap((value) => String(value).split(','))
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ];

  if (!validSet) return cleaned;
  return cleaned.filter((item) => validSet.has(item));
}

function isGeneralJobSearch(jobTitles) {
  return jobTitles.some(
    (title) => title.toLowerCase() === GENERAL_JOB_TITLE.toLowerCase()
  );
}

function resolveJobTitleQueryTerms(jobTitles) {
  if (isGeneralJobSearch(jobTitles)) {
    return GENERAL_JSEARCH_TERMS;
  }
  return jobTitles.filter(
    (title) => title.toLowerCase() !== GENERAL_JOB_TITLE.toLowerCase()
  );
}

function normalizeJobTitles(body) {
  const fromJobTitles = normalizeStringArray(body, 'jobTitles');
  if (fromJobTitles.length) return fromJobTitles;
  return normalizeStringArray(body, 'jobTitle');
}

function normalizeRegions(body) {
  return normalizeStringArray(body, 'region', VALID_REGION_CODES);
}

function normalizeJobScopes(body) {
  return normalizeStringArray(body, 'jobScope');
}

const RESUME_SUMMARY_MAX_WORDS = 200;

const RESUME_TECH_SKILLS = [
  'TypeScript',
  'JavaScript',
  'Node.js',
  'React',
  'React Native',
  'Next.js',
  'Vue.js',
  'Angular',
  'Assembly',
  'C++',
  'C#',
  '.NET',
  'Java',
  'Python',
  'SQL',
  'PostgreSQL',
  'MySQL',
  'MongoDB',
  'Redis',
  'Git',
  'GitHub',
  'GitLab',
  'HTML',
  'CSS',
  'SASS',
  'REST',
  'GraphQL',
  'Docker',
  'Kubernetes',
  'AWS',
  'Azure',
  'GCP',
  'Linux',
  'Unix',
  'Bash',
  'Shell',
  'Selenium',
  'Cypress',
  'Playwright',
  'JUnit',
  'TestNG',
  'Maven',
  'Gradle',
  'Spring',
  'Spring Boot',
  'Django',
  'Flask',
  'FastAPI',
  'Express',
  'JSON',
  'XML',
  'OOP',
  'CI/CD',
  'DevOps',
  'Jenkins',
  'Jira',
  'TensorFlow',
  'PyTorch',
  'Pandas',
  'NumPy',
  'Machine Learning',
  'Deep Learning',
  'Android',
  'Kotlin',
  'Swift',
  'iOS',
  'Go',
  'Golang',
  'Rust',
  'Ruby',
  'PHP',
  'Laravel',
  'QA',
  'Automation',
  'Manual Testing',
  'API Testing',
  'Postman',
  'Swagger',
  'Microservices',
  'Agile',
  'Scrum',
];

const RESUME_EDUCATION_TERMS = [
  'Ben-Gurion University',
  'Ben Gurion University',
  'BGU',
  'Technion',
  'Tel Aviv University',
  'TAU',
  'Hebrew University',
  'University of Haifa',
  'Reichman University',
  'IDC Herzliya',
  'Ariel University',
  'Open University',
  'Computer Science',
  'Software Engineering',
  'Information Systems',
  'Electrical Engineering',
  'Data Science',
  'Cyber Security',
  'Cybersecurity',
  'B.Sc',
  'B.S.',
  'Bachelor of Science',
  'Bachelor',
  'M.Sc',
  'Master of Science',
  'Master',
  'Student',
  'Undergraduate',
  'Graduate',
  'First-Year',
  'Second-Year',
  'Third-Year',
  'Fourth-Year',
  'Sophomore',
  'Junior',
  'Senior',
  "Dean's List",
  'GPA',
  'Honors',
  'Magna Cum Laude',
  'Summa Cum Laude',
];

const RESUME_TECH_ROLE_TERMS = [
  'Software Engineer',
  'Software Developer',
  'Full Stack Developer',
  'Fullstack Developer',
  'Backend Developer',
  'Frontend Developer',
  'Web Developer',
  'QA Engineer',
  'QA Automation Engineer',
  'Automation Engineer',
  'Manual QA Engineer',
  'DevOps Engineer',
  'Data Engineer',
  'Data Analyst',
  'Machine Learning Engineer',
  'R&D Intern',
  'Software Intern',
  'Student Developer',
  'Junior Developer',
];

const RESUME_NOISE_LINE_PATTERNS = [
  /\bproctor(?:ing)?\b/i,
  /\btutor(?:ing)?\b/i,
  /\bretail\b/i,
  /\bcashier\b/i,
  /\bwaiter\b/i,
  /\bwaitress\b/i,
  /\bbarista\b/i,
  /\bwarehouse\b/i,
  /\bdelivery\b/i,
  /\bmilitary service\b/i,
  /\bidf\b/i,
  /\bsoft skills?\b/i,
  /\bteam player\b/i,
  /\bcommunication skills?\b/i,
  /\bleadership skills?\b/i,
  /\bproblem solving\b/i,
  /\btime management\b/i,
  /\breferences available\b/i,
  /\bhobbies?\b/i,
  /\binterests?\b/i,
];

function truncateToWordLimit(text, maxWords) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termPattern(term) {
  if (term === 'C++') return /\bc\s*\+\+\b|\bc\+\+\b/i;
  if (term === 'C#') return /\bc\s*#\b|\bc#\b/i;
  if (term === 'Java') return /\bjava\b(?!\s*script)/i;
  if (term === '.NET') return /\b\.?\s*net\b/i;
  if (term === 'Node.js') return /\bnode\.?\s*js\b/i;
  if (term === 'CI/CD') return /\bci\s*\/\s*cd\b/i;
  return new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
}

function extractResumeTerms(text, terms) {
  const found = [];
  const seen = new Set();
  const sorted = [...terms].sort((a, b) => b.length - a.length);

  for (const term of sorted) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    if (termPattern(term).test(text)) {
      seen.add(key);
      found.push(term);
    }
  }

  return found;
}

function extractEducationYearContext(text) {
  const matches = [];
  const yearRange =
    /\b(20\d{2})\s*(?:[-–—]|to|through)\s*(20\d{2}|present|current|today)\b/gi;
  let match;
  while ((match = yearRange.exec(text)) !== null) {
    matches.push(`${match[1]}-${match[2]}`);
  }
  return [...new Set(matches)];
}

function extractGpaSnippet(text) {
  const match = text.match(/\bGPA[\s:]*[\d.]+(?:\s*\/\s*[\d.]+)?/i);
  return match ? match[0].replace(/\s+/g, ' ').trim() : '';
}

function isNoiseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3) return true;
  return RESUME_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function buildFallbackResumeSnippet(text, maxWords) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && !isNoiseLine(line));

  return truncateToWordLimit(lines.join(' '), maxWords);
}

function cleanAndSummarizeResume(text) {
  if (!text?.trim()) return '';

  const normalized = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();

  const skills = extractResumeTerms(normalized, RESUME_TECH_SKILLS);
  const education = extractResumeTerms(normalized, RESUME_EDUCATION_TERMS);
  const roles = extractResumeTerms(normalized, RESUME_TECH_ROLE_TERMS);
  const years = extractEducationYearContext(normalized);
  const gpa = extractGpaSnippet(normalized);

  const sections = [];

  if (skills.length) {
    sections.push(`Technical skills: ${skills.join(', ')}`);
  }
  if (education.length || years.length || gpa) {
    const eduParts = [...education];
    if (years.length) eduParts.push(`Years: ${years.join(', ')}`);
    if (gpa) eduParts.push(gpa);
    sections.push(`Education: ${eduParts.join('; ')}`);
  }
  if (roles.length) {
    sections.push(`Target roles: ${roles.join(', ')}`);
  }

  let summary = sections.join('. ');

  if (!summary) {
    summary = buildFallbackResumeSnippet(normalized, RESUME_SUMMARY_MAX_WORDS);
  } else {
    summary = truncateToWordLimit(summary, RESUME_SUMMARY_MAX_WORDS);
  }

  return summary.trim();
}

function buildJSearchQuery({ jobTitles, regions }) {
  const parts = [];

  parts.push(...resolveJobTitleQueryTerms(jobTitles));

  if (regions.length) {
    for (const code of regions) {
      const label = REGION_SEARCH_TERMS[code] || code;
      parts.push(label);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function normalizeRegion(region) {
  if (Array.isArray(region)) {
    return region.find((code) => VALID_REGION_CODES.has(code)) || '';
  }
  const code = (region ?? '').trim();
  if (!code) return '';
  if (!VALID_REGION_CODES.has(code)) {
    console.warn(`[Scout] Unknown region code "${code}" — skipping`);
    return '';
  }
  return code;
}

function pickFromPool(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickCityForRegion(regionCode) {
  const code = regionCode || '';

  if (!code) {
    return pickFromPool(ALL_CITIES);
  }

  const englishPool = REGION_CITY_POOLS[code];
  if (englishPool?.length) {
    return pickFromPool(englishPool);
  }

  const hebrewPool = settlementsByRegion[code] || [];
  if (hebrewPool.length) {
    const settlement = pickFromPool(hebrewPool);
    return HEBREW_TO_ENGLISH_CITY[settlement] || settlement;
  }

  return 'Israel';
}

function pickTitleForJob(jobTitles, index) {
  if (jobTitles.length === 0 || isGeneralJobSearch(jobTitles)) {
    return GENERAL_JSEARCH_TERMS[index % GENERAL_JSEARCH_TERMS.length];
  }
  if (jobTitles.length === 1) return jobTitles[0];
  return jobTitles[index % jobTitles.length];
}

function toDateOnlyString(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateOnly(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isOnOrAfterMinDate(datePublished, minDatePublished) {
  return datePublished >= minDatePublished;
}

function filterJobsByMaxDatePublished(jobs, maxDatePublished) {
  const minDate = maxDatePublished?.trim();
  if (!minDate) return jobs;

  return jobs.filter((job) => {
    const published = job.datePublished?.trim();
    if (!published) return true;
    return isOnOrAfterMinDate(published, minDate);
  });
}

function buildMockJobDatePublished(index, maxDatePublished) {
  const minDate = maxDatePublished?.trim();

  if (minDate) {
    const published = parseDateOnly(minDate);
    published.setUTCDate(published.getUTCDate() + index);
    return toDateOnlyString(published);
  }

  const published = new Date();
  published.setUTCDate(published.getUTCDate() - (index + 1) * 4);
  return toDateOnlyString(published);
}

function buildMockJobs({ region, jobScope, jobTitles, maxDatePublished }) {
  const scope = jobScope || 'Full-time';
  const regionCode = normalizeRegion(region);

  const templates = [
    { company: 'NovaTech Labs', matchPercentage: 94 },
    { company: 'CloudBridge Systems', matchPercentage: 81 },
    { company: 'DataPulse Analytics', matchPercentage: 72 },
  ];

  return templates.map((template, index) => ({
    id: `mock-${index + 1}-${Date.now()}`,
    title: pickTitleForJob(jobTitles, index),
    company: template.company,
    datePublished: buildMockJobDatePublished(index, maxDatePublished),
    jobScope: scope,
    location: pickCityForRegion(regionCode),
    matchPercentage: template.matchPercentage,
    coverLetterUrl: `https://example.com/scouterai/cover-letters/${encodeURIComponent(
      template.company
    )}-${index + 1}.pdf`,
    applyLink: '',
  }));
}

function normalizeDatePublished(value) {
  if (!value) return '';
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return str;
  return toDateOnlyString(parsed);
}

function normalizeJobFromApi(raw, index) {
  return {
    id: raw.id || raw.job_id || raw.jobId || `job-${index + 1}-${Date.now()}`,
    title: raw.title || raw.job_title || raw.jobTitle || 'Untitled role',
    company:
      raw.company ||
      raw.employer_name ||
      raw.employerName ||
      raw.company_name ||
      'Unknown company',
    datePublished: normalizeDatePublished(
      raw.datePublished ||
        raw.job_posted_at ||
        raw.job_posted_at_datetime_utc ||
        raw.posted_at
    ),
    jobScope:
      raw.jobScope ||
      raw.job_employment_type ||
      raw.employment_type ||
      raw.job_type ||
      '',
    location:
      raw.location ||
      raw.job_city ||
      raw.job_location ||
      raw.job_city_name ||
      '',
    matchPercentage:
      raw.matchPercentage ?? raw.match_percentage ?? raw.matchScore ?? null,
    coverLetterUrl: raw.coverLetterUrl || raw.cover_letter_url || '',
    coverLetter: raw.coverLetter || raw.cover_letter || '',
    applyLink:
      raw.applyLink ||
      raw.job_url ||
      raw.job_apply_link ||
      raw.job_apply_quality_score?.link ||
      raw.apply_url ||
      '',
  };
}

function extractJobsArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  const arrayKeys = [
    'jobs',
    'mockJobs',
    'results',
    'analyzedJobs',
    'output',
    'data',
  ];

  for (const key of arrayKeys) {
    const value = data[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value.jobs)) {
      return value.jobs;
    }
  }

  if (data.body !== undefined) {
    const inner =
      typeof data.body === 'string' ? parseMakeResponseBody(data.body) : data.body;
    return extractJobsArray(inner);
  }

  return [];
}

function parseMakeResponseBody(rawText) {
  if (!rawText?.trim()) return null;

  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed === 'string') {
      try {
        return JSON.parse(parsed);
      } catch {
        return null;
      }
    }
    return parsed;
  } catch {
    console.warn(
      `[Make.com] Non-JSON response body: ${rawText.slice(0, 200)}`
    );
    return null;
  }
}

function finalizeJobsFromMakeResponse(data, maxDatePublished) {
  let jobs = parseJobsFromMakeResponse(data);
  jobs = filterJobsByMaxDatePublished(jobs, maxDatePublished);
  jobs.sort((a, b) => (b.matchPercentage ?? 0) - (a.matchPercentage ?? 0));
  return jobs;
}

function createSearchJob(searchJobId, filters) {
  searchJobs.set(searchJobId, {
    status: 'pending',
    jobs: [],
    filters,
    createdAt: new Date().toISOString(),
  });
}

function buildWorkerEnv() {
  return {
    ...process.env,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    BACKEND_CALLBACK_URL:
      process.env.BACKEND_CALLBACK_URL || `http://localhost:${PORT}/api/callback`,
  };
}

function spawnWorkerForSearch(searchJobId) {
  if (!searchJobId) {
    console.error('[Scout] Cannot spawn worker — missing searchJobId');
    return;
  }

  if (!fs.existsSync(WORKER_SCRIPT_PATH)) {
    const message = `worker.py not found at ${WORKER_SCRIPT_PATH}`;
    console.error(`[Scout] ${message}`);
    failSearchJob(searchJobId, message);
    return;
  }

  const workerEnv = buildWorkerEnv();
  const workerArgs = [WORKER_SCRIPT_PATH, searchJobId];

  console.log('[Scout] Triggering background worker with:');
  console.log(`  python: ${PYTHON_BIN}`);
  console.log(`  script: ${WORKER_SCRIPT_PATH}`);
  console.log(`  cwd:    ${PROJECT_ROOT}`);
  console.log(`  args:   ${workerArgs.join(' ')}`);

  const worker = spawn(PYTHON_BIN, workerArgs, {
    cwd: PROJECT_ROOT,
    env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: false,
  });

  const logPrefix = `[Worker:${searchJobId.slice(0, 8)}]`;

  worker.on('spawn', () => {
    console.log(
      `[Scout] Worker process successfully triggered — pid ${worker.pid}, searchJobId: ${searchJobId}`
    );
  });

  worker.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    console.log(`${logPrefix} [stdout] ${text.trimEnd()}`);
  });

  worker.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    console.error(`${logPrefix} [stderr] ${text.trimEnd()}`);
  });

  worker.on('error', (error) => {
    console.error(
      `[Scout] Failed to start worker for ${searchJobId}:`,
      error.message
    );
    failSearchJob(
      searchJobId,
      `Failed to start background worker: ${error.message}`
    );
  });

  worker.on('close', (code, signal) => {
    if (code === 0) {
      console.log(`[Scout] Worker finished for ${searchJobId} (exit code 0)`);
      return;
    }
    console.error(
      `[Scout] Worker exited for ${searchJobId} — code ${code ?? 'null'}, signal ${signal ?? 'null'}`
    );
  });
}

function completeSearchJob(searchJobId, jobs) {
  const entry = searchJobs.get(searchJobId);
  if (!entry || entry.status === 'completed') return false;

  entry.status = 'completed';
  entry.jobs = jobs;
  entry.completedAt = new Date().toISOString();
  console.log(
    `[Scout] Search job completed — searchJobId: ${searchJobId}, ${jobs.length} job(s)`
  );

  notifySearchEventClients(searchJobId, 'search-complete', {
    searchJobId,
    status: 'completed',
    jobs,
  });
  closeSearchEventClients(searchJobId);
  return true;
}

function failSearchJob(searchJobId, errorMessage) {
  const entry = searchJobs.get(searchJobId);
  if (!entry || entry.status === 'completed') return;

  entry.status = 'failed';
  entry.error = errorMessage;
  entry.completedAt = new Date().toISOString();
  console.error(`[Scout] Search job failed — searchJobId: ${searchJobId}: ${errorMessage}`);

  notifySearchEventClients(searchJobId, 'search-failed', {
    searchJobId,
    status: 'failed',
    error: errorMessage,
  });
  closeSearchEventClients(searchJobId);
}

function getSearchJobStatus(searchJobId) {
  const entry = searchJobs.get(searchJobId);
  if (!entry) return null;

  if (
    (entry.status === 'pending' || entry.status === 'processing') &&
    Date.now() - new Date(entry.createdAt).getTime() > SEARCH_JOB_TIMEOUT_MS
  ) {
    failSearchJob(
      searchJobId,
      'Search timed out waiting for Make.com analysis. Please try again.'
    );
    return searchJobs.get(searchJobId);
  }

  return entry;
}

function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function registerSearchEventClient(searchJobId, res) {
  if (!searchEventClients.has(searchJobId)) {
    searchEventClients.set(searchJobId, new Set());
  }
  searchEventClients.get(searchJobId).add(res);
}

function removeSearchEventClient(searchJobId, res) {
  searchEventClients.get(searchJobId)?.delete(res);
  if (searchEventClients.get(searchJobId)?.size === 0) {
    searchEventClients.delete(searchJobId);
  }
}

function notifySearchEventClients(searchJobId, eventName, payload) {
  const clients = searchEventClients.get(searchJobId);
  if (!clients?.size) return;

  for (const client of clients) {
    sendSseEvent(client, eventName, payload);
  }
}

function closeSearchEventClients(searchJobId) {
  const clients = searchEventClients.get(searchJobId);
  if (!clients) return;

  for (const client of clients) {
    client.end();
  }
  searchEventClients.delete(searchJobId);
}

function extractRawJobsFromCallbackBody(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.jobs)) return body.jobs;
  if (Array.isArray(body?.results)) return body.results;
  return [];
}

function parseJobsFromWorkerCallback(body) {
  const rawJobs = extractRawJobsFromCallbackBody(body);
  return rawJobs.map((raw, index) => normalizeJobFromApi(raw, index)).slice(0, MAX_JOBS);
}

function finalizeJobsFromWorkerCallback(body, maxDatePublished) {
  let jobs = parseJobsFromWorkerCallback(body);
  jobs = filterJobsByMaxDatePublished(jobs, maxDatePublished);
  jobs.sort((a, b) => (b.matchPercentage ?? 0) - (a.matchPercentage ?? 0));
  return jobs;
}

function extractSearchJobIdFromCallbackBody(body) {
  return body?.searchJobId || body?.searchId || '';
}

function processMakeCallback(searchJobId, body, res) {
  const entry = searchJobs.get(searchJobId);

  if (!entry) {
    console.warn(`[Scout] Callback for unknown searchJobId: ${searchJobId}`);
    return res.status(404).json({ error: 'Unknown search job' });
  }

  console.log(
    '[Scout] Raw payload from Python Worker:',
    JSON.stringify(body).slice(0, 500)
  );

  const rawJobs = extractRawJobsFromCallbackBody(body);
  console.log(
    `[Scout] Extracted ${rawJobs.length} job(s) from req.body.jobs — searchJobId: ${searchJobId}`
  );

  const maxDatePublished = entry.filters?.maxDatePublished;
  const jobs = finalizeJobsFromWorkerCallback(body, maxDatePublished);

  console.log(
    `[Scout] Callback from Python Worker — searchJobId: ${searchJobId}, ${jobs.length} job(s) ready for frontend`
  );

  completeSearchJob(searchJobId, jobs);
  return res.json({ ok: true, searchJobId, status: 'completed', jobCount: jobs.length });
}

function parseJobsFromMakeResponse(data) {
  const jobs = extractJobsArray(data).map((raw, index) =>
    normalizeJobFromApi(raw, index)
  );

  return jobs.slice(0, MAX_JOBS);
}

/**
 * Fire-and-forget trigger to Make.com. If the webhook body already contains
 * analyzed jobs, complete the search job in the background.
 */
function triggerMakeComSearch(searchJobId, makePayload, maxDatePublished) {
  const startedAt = Date.now();

  forwardToMakeCom(makePayload)
    .then((data) => {
      const jobs = finalizeJobsFromMakeResponse(data, maxDatePublished);
      const elapsedMs = Date.now() - startedAt;

      if (jobs.length > 0) {
        console.log(
          `[Make.com] Background sync response — searchJobId: ${searchJobId}, ${jobs.length} job(s) in ${elapsedMs}ms`
        );
        completeSearchJob(searchJobId, jobs);
      } else {
        console.log(
          `[Make.com] Background sync ack (0 jobs) — searchJobId: ${searchJobId}, awaiting callback (${elapsedMs}ms)`
        );
      }
    })
    .catch((error) => {
      console.error(
        `[Make.com] Background trigger failed — searchJobId: ${searchJobId}:`,
        error.message
      );
    });
}

function buildMakePayload(formFields, file, resumeText, searchJobId) {
  const { region, jobScope, jobTitles, maxDatePublished } = formFields;
  const baseUrl = process.env.SCOUTER_BASE_URL || `http://localhost:${PORT}`;
  const query = buildJSearchQuery({
    jobTitles,
    jobScopes: jobScope,
    regions: region,
  });

  return {
    searchId: searchJobId,
    searchJobId,
    callbackUrl: `${baseUrl}/api/callback`,
    region,
    regions: region,
    regionLabel: region.length ? region.join(', ') : 'everywhere',
    jobScope,
    jobScopes: jobScope,
    jobTitles,
    searchMode: isGeneralJobSearch(jobTitles) ? 'general' : 'specific',
    maxDatePublished: maxDatePublished || null,
    query,
    resumeText: resumeText || '',
    resume: {
      originalname: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
    },
    forwardedAt: new Date().toISOString(),
  };
}

async function forwardToMakeCom(payload) {
  const startedAt = Date.now();
  try {
    const textLength = (payload.resumeText || '').length;
    console.log(
      `[Make.com] Triggering webhook — searchJobId: ${payload.searchJobId}, regions: [${payload.regions.join(', ') || 'everywhere'}], scopes: [${payload.jobScopes.join(', ')}], resumeText: ${textLength} chars`
    );

    const response = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(MAKE_FETCH_TIMEOUT_MS),
    });

    const rawText = await response.text();

    if (!response.ok) {
      console.error(
        `[Make.com] Forward failed — HTTP ${response.status}${
          rawText ? `: ${rawText.slice(0, 300)}` : ''
        }`
      );
      return null;
    }

    const responseData = parseMakeResponseBody(rawText);
    const parsedCount = extractJobsArray(responseData).length;
    const elapsedMs = Date.now() - startedAt;

    console.log(
      `[Make.com] Webhook HTTP response after ${elapsedMs}ms — ${parsedCount} job(s) in body`
    );

    return responseData;
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      console.error(
        `[Make.com] Webhook timed out after ${MAKE_FETCH_TIMEOUT_MS}ms — is Webhook response configured at end of scenario?`
      );
    } else {
      console.error('[Make.com] Forward failed —', error.message);
    }
    return null;
  }
}

app.post('/api/callback', (req, res) => {
  console.log(
    '[Callback] POST /api/callback — payload from Python Worker:',
    JSON.stringify(req.body).slice(0, 500)
  );

  const searchJobId = extractSearchJobIdFromCallbackBody(req.body);
  if (!searchJobId) {
    console.warn('[Callback] Missing searchJobId/searchId in Python Worker payload');
    return res.status(400).json({ error: 'searchJobId is required in callback body' });
  }

  return processMakeCallback(searchJobId, req.body, res);
});

app.post('/api/scout/callback/:searchJobId', (req, res) => {
  const { searchJobId } = req.params;
  return processMakeCallback(searchJobId, req.body, res);
});

app.get('/api/search-events/:searchJobId', (req, res) => {
  const { searchJobId } = req.params;
  const entry = getSearchJobStatus(searchJobId);

  if (!entry) {
    return res.status(404).json({ error: 'Search job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  sendSseEvent(res, 'connected', { searchJobId, status: entry.status });

  if (entry.status === 'completed') {
    sendSseEvent(res, 'search-complete', {
      searchJobId,
      status: 'completed',
      jobs: entry.jobs,
    });
    res.end();
    return;
  }

  if (entry.status === 'failed') {
    sendSseEvent(res, 'search-failed', {
      searchJobId,
      status: 'failed',
      error: entry.error || 'Search failed',
    });
    res.end();
    return;
  }

  registerSearchEventClient(searchJobId, res);

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSearchEventClient(searchJobId, res);
  });
});

app.get('/api/search-status/:searchJobId', async (req, res) => {
  const { searchJobId } = req.params;
  const entry = getSearchJobStatus(searchJobId);

  if (!entry) {
    return res.status(404).json({ error: 'Search job not found' });
  }

  if (entry.status === 'completed') {
    return res.json({
      status: 'completed',
      searchJobId,
      jobs: entry.jobs,
      meta: {
        filters: entry.filters,
        completedAt: entry.completedAt,
        maxJobsCap: MAX_JOBS,
      },
    });
  }

  try {
    const tursoJobs = await getFoundJobsByPreferenceId(searchJobId);
    if (tursoJobs.length > 0) {
      completeSearchJob(searchJobId, tursoJobs.slice(0, MAX_JOBS));
      const updated = searchJobs.get(searchJobId);
      return res.json({
        status: 'completed',
        searchJobId,
        jobs: updated.jobs,
        meta: {
          filters: updated.filters,
          completedAt: updated.completedAt,
          maxJobsCap: MAX_JOBS,
          source: 'turso',
        },
      });
    }
  } catch (tursoError) {
    console.warn('[Scout] Turso status lookup skipped —', tursoError.message);
  }

  if (entry.status === 'failed') {
    return res.json({
      status: 'failed',
      searchJobId,
      error: entry.error || 'Search failed',
    });
  }

  return res.json({
    status: entry.status === 'processing' ? 'processing' : 'pending',
    searchJobId,
  });
});

app.get('/api/results/:searchJobId', async (req, res) => {
  const { searchJobId } = req.params;

  try {
    const results = await getSearchResults(searchJobId);

    if (!results) {
      return res.status(404).json({ error: 'Search not found' });
    }

    return res.json(results);
  } catch (error) {
    console.error('[Scout] Failed to load search results —', error.message);
    return res.status(500).json({
      error: error.message || 'Failed to load search results',
    });
  }
});

app.post('/api/scout', upload.single('resume'), async (req, res) => {
  const region = normalizeRegions(req.body);
  const jobScope = normalizeJobScopes(req.body);
  const { maxDatePublished } = req.body;
  const jobTitles = normalizeJobTitles(req.body);

  console.log('[Scout] Incoming search request');
  console.log(
    `[Scout] jobTitles (${jobTitles.length}, mode: ${isGeneralJobSearch(jobTitles) ? 'general' : 'specific'}):`,
    jobTitles
  );
  console.log(
    `[Scout] regions (${region.length}):`,
    region.length ? region : ['everywhere (כל הארץ)']
  );
  console.log(`[Scout] jobScopes (${jobScope.length}):`, jobScope);
  console.log(
    `[Scout] maxDatePublished: ${maxDatePublished?.trim() || '(none — no minimum date filter)'}`
  );
  console.log(
    `[Scout] JSearch query: "${buildJSearchQuery({ jobTitles, jobScopes: jobScope, regions: region })}"`
  );

  if (!req.file) {
    return res.status(400).json({ error: 'Resume PDF is required' });
  }
  if (jobScope.length === 0 || jobTitles.length === 0) {
    return res.status(400).json({
      error: 'At least one jobScope and one jobTitle are required',
    });
  }

  let resumeText = '';
  try {
    const parsed = await pdfParse(req.file.buffer);
    const rawResumeText = (parsed?.text ?? '').trim();
    resumeText = cleanAndSummarizeResume(rawResumeText);
    console.log(
      `[Scout] Extracted ${rawResumeText.length} characters from resume PDF (${req.file.originalname})`
    );
    console.log(
      `[Scout] Resume summarized for worker — ${rawResumeText.length} → ${resumeText.length} chars (${resumeText.split(/\s+/).filter(Boolean).length} words)`
    );
  } catch (error) {
    console.error('[Scout] PDF text extraction failed —', error.message);
    resumeText = '';
  }

  const searchMode = isGeneralJobSearch(jobTitles) ? 'general' : 'specific';
  const jsearchQuery = buildJSearchQuery({ jobTitles, regions: region });

  try {
    const searchJobId = crypto.randomUUID();

    await saveUserPreferences({
      searchJobId,
      regions: region,
      jobScopes: jobScope,
      jobTitles,
      maxDatePublished,
      resumeText,
      resumeFileName: req.file.originalname,
      searchMode,
      jsearchQuery,
    });

    await saveLatestUserPreferences({
      regions: region,
      jobScopes: jobScope,
      jobTitles,
      maxDatePublished,
      resumeText,
      resumeFileName: req.file.originalname,
      searchMode,
      jsearchQuery,
    });

    console.log(
      `[Scout] Saved user preferences to Turso — searchJobId: ${searchJobId}, resumeText: ${resumeText.length} chars`
    );
    console.log('[Scout] Updated UserPreferences (latest) for manual worker runs');

    return res.status(200).json({ message: 'Search triggered', searchJobId });
  } catch (error) {
    console.error('[Scout] Failed to save preferences to Turso —', error.message);
    return res.status(500).json({
      error: error.message || 'Failed to save search preferences to database',
    });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Upload failed' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`ScouterAI API listening on http://localhost:${PORT}`);
  console.log(`[Worker] Python binary: ${PYTHON_BIN}`);
  console.log(`[Worker] Script path: ${WORKER_SCRIPT_PATH}`);
  console.log(`[Worker] Project root (cwd): ${PROJECT_ROOT}`);
  console.log(
    `[Locations] Loaded ${Object.keys(locations).length} settlement mappings across 8 region codes`
  );
});

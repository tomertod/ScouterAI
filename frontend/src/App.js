import { useEffect, useRef, useState } from 'react';
import './App.css';
import ScoutCharacter from './ScoutCharacter';

const API_BASE_URL = 'http://localhost:5001';
const API_SCOUT_URL = `${API_BASE_URL}/api/scout`;
const RESULTS_POLL_MS = 2000;

const GENERAL_JOB_TITLE = 'General';

const PRESET_JOB_TITLES = [
  'React Developer',
  'QA Automation Engineer',
  'Manual QA Engineer',
  'Java Developer',
  'Python Developer',
  'Junior Python Developer',
  'C++ Developer',
  'Fullstack Developer',
  'Backend Developer',
  'Junior Backend Developer',
  'Frontend Developer',
  'Node.js Developer',
  'Software Engineering Student',
  'Student Software Developer',
  'Junior Software Engineer',
  'DevOps Engineer',
  'Data Analyst',
  'Data & AI Intern',
  'QA Student',
  'Cloud Computing Intern',
  'Mobile Developer Student',
];

const REGIONS = [
  { label: 'North', value: 'north' },
  { label: 'Haifa & Krayot', value: 'haifa_krayot' },
  { label: 'Sharon', value: 'sharon' },
  { label: 'Center', value: 'center' },
  { label: 'Jerusalem Area', value: 'jerusalem' },
  { label: 'South', value: 'south' },
  { label: 'Arava', value: 'arava' },
  { label: 'Eilat', value: 'eilat' },
];

const JOB_SCOPES = [
  'Full-time',
  'Part-time',
  'Student',
  'Internship',
  'Temporary',
];

const initialForm = {
  region: [],
  jobScope: [],
  maxDatePublished: '',
};

function getMatchPercentageColor(percentage) {
  if (percentage >= 70) return '#2ECC40';
  if (percentage >= 50) return '#FF851B';
  return '#FF4136';
}

function normalizeJobsList(raw) {
  return Array.isArray(raw) ? raw : [];
}

function getCoverLetterText(job) {
  return (job?.coverLetter ?? '').trim();
}

function slugifyForFilename(value) {
  return (
    (value || 'cover-letter')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'cover-letter'
  );
}

function downloadCoverLetterAsTxt(job) {
  const text = getCoverLetterText(job);
  if (!text) return;

  const filename = `cover-letter-${slugifyForFilename(job.company || job.title)}.txt`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function App() {
  const formRef = useRef(null);
  const statusRef = useRef(null);
  const [form, setForm] = useState(initialForm);
  const [isGeneralMode, setIsGeneralMode] = useState(false);
  const [jobTitles, setJobTitles] = useState([]);
  const [resumeFile, setResumeFile] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchJobId, setSearchJobId] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [resultsReady, setResultsReady] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const toggleMultiSelect = (field, value) => {
    setForm((prev) => {
      const current = prev[field];
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
      return { ...prev, [field]: next };
    });
  };

  const handleResumeChange = (event) => {
    setResumeFile(event.target.files?.[0] ?? null);
  };

  const toggleGeneralMode = () => {
    setIsGeneralMode((prev) => {
      if (prev) return false;
      setJobTitles([]);
      return true;
    });
  };

  const toggleJobTitle = (title) => {
    setIsGeneralMode(false);
    setJobTitles((prev) =>
      prev.includes(title)
        ? prev.filter((item) => item !== title)
        : [...prev, title]
    );
  };

  const removeJobTitle = (titleToRemove) => {
    setJobTitles((prev) => prev.filter((title) => title !== titleToRemove));
  };

  const clearGeneralMode = () => {
    setIsGeneralMode(false);
  };

  const handleReset = () => {
    setSearchJobId(null);
    setJobs([]);
    setResultsReady(false);
    setIsLoading(false);
    setError('');
    setForm(initialForm);
    setIsGeneralMode(false);
    setJobTitles([]);
    setResumeFile(null);
    if (formRef.current) {
      formRef.current.reset();
    }
  };

  useEffect(() => {
    if (!searchJobId || !isLoading) {
      return undefined;
    }

    let cancelled = false;

    const pollResults = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/results/${searchJobId}`);
        let data = {};
        try {
          data = await response.json();
        } catch {
          throw new Error('Invalid response while checking results.');
        }

        if (!response.ok) {
          throw new Error(data?.error || 'Failed to load search results.');
        }

        if (cancelled) return;

        const status = typeof data?.status === 'string' ? data.status : '';

        if (status === 'completed') {
          setJobs(normalizeJobsList(data?.jobs));
          setResultsReady(true);
          setIsLoading(false);
          return;
        }

        if (status === 'failed') {
          setError('Search failed. Please try again.');
          setIsLoading(false);
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError.message || 'Failed while waiting for results.');
          setIsLoading(false);
        }
      }
    };

    pollResults();
    const intervalId = setInterval(pollResults, RESULTS_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [searchJobId, isLoading]);

  const handleSearch = async (event) => {
    event.preventDefault();
    setError('');
    setResultsReady(false);
    setJobs([]);
    setSearchJobId(null);

    if (!resumeFile) {
      setError('Please upload your resume (PDF).');
      return;
    }

    const titlesToSubmit = isGeneralMode ? [GENERAL_JOB_TITLE] : [...jobTitles];

    if (titlesToSubmit.length === 0) {
      setError('Please select General mode or at least one job title.');
      return;
    }
    if (form.jobScope.length === 0) {
      setError('Please select at least one job scope.');
      return;
    }

    const body = new FormData();
    body.append('resume', resumeFile);
    form.region.forEach((code) => body.append('region', code));
    form.jobScope.forEach((scope) => body.append('jobScope', scope));
    titlesToSubmit.forEach((title) => body.append('jobTitles', title));
    body.append('maxDatePublished', form.maxDatePublished);

    setIsLoading(true);

    requestAnimationFrame(() => {
      statusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    try {
      const response = await fetch(API_SCOUT_URL, {
        method: 'POST',
        body,
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        throw new Error('Server returned an invalid response. Is the backend running on port 5001?');
      }

      if (!response.ok) {
        throw new Error(
          typeof data?.error === 'string'
            ? data.error
            : 'Search failed. Please try again.'
        );
      }

      const id = typeof data?.searchJobId === 'string' ? data.searchJobId.trim() : '';
      if (!id) {
        throw new Error('Server did not return a searchJobId.');
      }

      setSearchJobId(id);
    } catch (err) {
      setError(err.message || 'Network error. Is the backend running on port 5001?');
      setIsLoading(false);
    }
  };

  const renderStatusSection = () => {
    if (isLoading) {
      return (
        <section
          ref={statusRef}
          className="panel loading-panel"
          aria-live="polite"
          aria-busy="true"
        >
          <p className="loading-title">Searching... (This may take up to a minute)</p>
          <p className="loading-subtitle">
            Run <code>python worker.py</code> in your terminal to process this search.
          </p>
        </section>
      );
    }

    if (resultsReady && Array.isArray(jobs)) {
      return (
        <section className="panel results-panel" aria-label="Search results">
          <h2>
            {jobs.length} match{jobs.length !== 1 ? 'es' : ''} found
          </h2>

          {jobs.length === 0 ? (
            <p>No jobs matched your filters. Try different options.</p>
          ) : (
            <ul className="job-list">
              {Array.isArray(jobs) &&
                jobs.map((job, index) => (
                  <li key={job?.id ?? `job-${index}`} className="job-card">
                    <div className="job-card-header">
                      <h3>{job?.title ?? 'Untitled role'}</h3>
                      {job?.matchPercentage != null && (
                        <span
                          className="match-badge"
                          style={{ color: getMatchPercentageColor(job.matchPercentage) }}
                        >
                          {job.matchPercentage}% match
                        </span>
                      )}
                    </div>
                    <p className="job-company">{job?.company ?? ''}</p>
                    <dl className="job-meta">
                      {job?.location && (
                        <div>
                          <dt>Location</dt>
                          <dd>{job.location}</dd>
                        </div>
                      )}
                      {job?.datePublished && (
                        <div>
                          <dt>Date published</dt>
                          <dd>{job.datePublished}</dd>
                        </div>
                      )}
                    </dl>
                    <div className="job-actions">
                      {job?.applyLink && (
                        <a
                          className="btn-primary btn-apply"
                          href={job.applyLink}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Apply for Job
                        </a>
                      )}
                      {getCoverLetterText(job) && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => downloadCoverLetterAsTxt(job)}
                        >
                          Download Cover Letter
                        </button>
                      )}
                    </div>
                  </li>
                ))}
            </ul>
          )}

          <button type="button" className="btn-link" onClick={handleReset}>
            Change options and try again
          </button>
        </section>
      );
    }

    return null;
  };

  return (
    <div className="app">
      <ScoutCharacter />

      <header className="app-header">
        <h1 className="app-title">ScouterAI</h1>
        <p>AI-powered job search — tracer bullet</p>
      </header>

      <main className="app-main">
        <section
          ref={formRef}
          className="panel search-panel"
          aria-label="Job search filters"
        >
          <h2>Find your next role</h2>
          <form onSubmit={handleSearch} className="search-form">
            <label className="field">
              <span>Resume (PDF)</span>
              <input
                type="file"
                name="resume"
                accept="application/pdf,.pdf"
                onChange={handleResumeChange}
                required
              />
            </label>

            <fieldset className="field checkbox-group">
              <legend>Region</legend>
              <p className="field-hint">Select one or more. Leave empty to search all of Israel.</p>
              <ul className="checkbox-list">
                {REGIONS.map(({ label, value }) => (
                  <li key={value}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        name="region"
                        value={value}
                        checked={form.region.includes(value)}
                        onChange={() => toggleMultiSelect('region', value)}
                      />
                      <span>{label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>

            <fieldset className="field checkbox-group">
              <legend>Job scope</legend>
              <ul className="checkbox-list">
                {JOB_SCOPES.map((scope) => (
                  <li key={scope}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        name="jobScope"
                        value={scope}
                        checked={form.jobScope.includes(scope)}
                        onChange={() => toggleMultiSelect('jobScope', scope)}
                      />
                      <span>{scope}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>

            <fieldset className="field job-titles-field">
              <legend>Job titles</legend>
              <p className="field-hint">
                Choose specific roles or use General to search broadly.
              </p>

              <button
                type="button"
                className={`general-mode-btn${isGeneralMode ? ' selected' : ''}`}
                aria-pressed={isGeneralMode}
                onClick={toggleGeneralMode}
              >
                General / Any Matching Role
              </button>

              <ul className="title-preset-grid" aria-label="Preset job titles">
                {PRESET_JOB_TITLES.map((title) => {
                  const isSelected = !isGeneralMode && jobTitles.includes(title);
                  return (
                    <li key={title}>
                      <button
                        type="button"
                        className={`title-preset-option${isSelected ? ' selected' : ''}`}
                        aria-pressed={isSelected}
                        disabled={isGeneralMode}
                        onClick={() => toggleJobTitle(title)}
                      >
                        {title}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {(isGeneralMode || jobTitles.length > 0) && (
                <ul className="title-chips" aria-label="Selected job titles">
                  {isGeneralMode ? (
                    <li className="title-chip title-chip-general">
                      <span>General / Any Matching Role</span>
                      <button
                        type="button"
                        className="title-chip-remove"
                        onClick={clearGeneralMode}
                        aria-label="Remove general search mode"
                      >
                        ×
                      </button>
                    </li>
                  ) : (
                    jobTitles.map((title) => (
                      <li key={title} className="title-chip">
                        <span>{title}</span>
                        <button
                          type="button"
                          className="title-chip-remove"
                          onClick={() => removeJobTitle(title)}
                          aria-label={`Remove ${title}`}
                        >
                          ×
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </fieldset>

            <label className="field">
              <span>Max date published (listings on or after)</span>
              <input
                type="date"
                name="maxDatePublished"
                value={form.maxDatePublished}
                onChange={handleChange}
              />
            </label>

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="btn-primary" disabled={isLoading}>
              {isLoading ? 'Searching…' : 'Search'}
            </button>
          </form>
        </section>

        {renderStatusSection()}
      </main>
    </div>
  );
}

export default App;

import { useEffect, useRef, useState } from 'react';
import './App.css';

const API_BASE_URL = 'http://localhost:5001';
const API_SCOUT_URL = `${API_BASE_URL}/api/scout`;
const SSE_FALLBACK_POLL_MS = 4500;

const GENERAL_JOB_TITLE = 'General';

const PRESET_JOB_TITLES = [
  'React Developer',
  'QA Automation Engineer',
  'Manual QA Engineer',
  'Java Developer',
  'Python Developer',
  'C++ Developer',
  'Fullstack Developer',
  'Backend Developer',
  'Frontend Developer',
  'Node.js Developer',
  'Software Engineering Student',
  'Junior Software Engineer',
  'DevOps Engineer',
  'Data Analyst',
];

const REGIONS = [
  { label: 'צפון', value: 'north' },
  { label: 'חיפה והקריות', value: 'haifa_krayot' },
  { label: 'השרון', value: 'sharon' },
  { label: 'מרכז', value: 'center' },
  { label: 'ירושלים והסביבה', value: 'jerusalem' },
  { label: 'דרום', value: 'south' },
  { label: 'ערבה', value: 'arava' },
  { label: 'אילת', value: 'eilat' },
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
  jobScope: ['Full-time'],
  maxDatePublished: '',
};

function normalizeJobsFromResponse(data) {
  const raw = data?.jobs ?? data?.mockJobs ?? [];
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
  const [form, setForm] = useState(initialForm);
  const [isGeneralMode, setIsGeneralMode] = useState(false);
  const [jobTitles, setJobTitles] = useState([]);
  const [resumeFile, setResumeFile] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [searchStatus, setSearchStatus] = useState('idle');
  const [error, setError] = useState('');
  const [coverLetterModal, setCoverLetterModal] = useState(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const loadingRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const eventSourceRef = useRef(null);

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const stopEventStream = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  const stopSearchTracking = () => {
    stopPolling();
    stopEventStream();
  };

  useEffect(() => () => stopSearchTracking(), []);

  useEffect(() => {
    if (!coverLetterModal) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setCoverLetterModal(null);
        setCopyFeedback('');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [coverLetterModal]);

  const openCoverLetterModal = (job) => {
    setCopyFeedback('');
    setCoverLetterModal({
      title: job.title,
      company: job.company,
      text: getCoverLetterText(job),
    });
  };

  const closeCoverLetterModal = () => {
    setCoverLetterModal(null);
    setCopyFeedback('');
  };

  const copyCoverLetterToClipboard = async () => {
    if (!coverLetterModal?.text) return;

    try {
      await navigator.clipboard.writeText(coverLetterModal.text);
      setCopyFeedback('Copied to clipboard');
    } catch {
      setCopyFeedback('Copy failed — select the text manually');
    }
  };

  const downloadModalCoverLetter = () => {
    if (!coverLetterModal) return;
    downloadCoverLetterAsTxt({
      title: coverLetterModal.title,
      company: coverLetterModal.company,
      coverLetter: coverLetterModal.text,
    });
  };

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
    const file = event.target.files?.[0] ?? null;
    setResumeFile(file);
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

  const applyCompletedSearch = (data) => {
    stopSearchTracking();
    setJobs(normalizeJobsFromResponse(data));
    setSearchStatus('complete');
  };

  const applyFailedSearch = (message) => {
    stopSearchTracking();
    setJobs(null);
    setSearchStatus('error');
    setError(message || 'Search failed. Please try again.');
  };

  const pollSearchStatus = async (searchJobId) => {
    const response = await fetch(`${API_BASE_URL}/api/search-status/${searchJobId}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to check search status.');
    }

    if (data.status === 'completed') {
      applyCompletedSearch(data);
      return data.status;
    }

    if (data.status === 'failed') {
      applyFailedSearch(data.error);
      return data.status;
    }

    return data.status;
  };

  const startPollingFallback = (searchJobId) => {
    stopPolling();
    pollIntervalRef.current = setInterval(() => {
      pollSearchStatus(searchJobId).catch((pollError) => {
        applyFailedSearch(pollError.message || 'Failed while checking search status.');
      });
    }, SSE_FALLBACK_POLL_MS);
  };

  const subscribeToSearchEvents = (searchJobId) => {
    stopEventStream();

    const source = new EventSource(
      `${API_BASE_URL}/api/search-events/${searchJobId}`
    );
    eventSourceRef.current = source;

    source.addEventListener('search-complete', (event) => {
      const data = JSON.parse(event.data);
      applyCompletedSearch(data);
    });

    source.addEventListener('search-failed', (event) => {
      const data = JSON.parse(event.data);
      applyFailedSearch(data.error);
    });

    source.onerror = () => {
      stopEventStream();
      pollSearchStatus(searchJobId)
        .then((status) => {
          if (status === 'processing') {
            startPollingFallback(searchJobId);
          }
        })
        .catch((pollError) => {
          applyFailedSearch(
            pollError.message || 'Lost connection while waiting for results.'
          );
        });
    };
  };

  const handleSearch = async (event) => {
    event.preventDefault();
    setError('');

    if (!resumeFile) {
      setError('Please upload your resume (PDF).');
      return;
    }

    const titlesToSubmit = isGeneralMode
      ? [GENERAL_JOB_TITLE]
      : [...jobTitles];

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

    stopSearchTracking();
    setSearchStatus('loading');
    setJobs(null);
    setError('');

    requestAnimationFrame(() => {
      loadingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    try {
      const response = await fetch(API_SCOUT_URL, {
        method: 'POST',
        body,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Search failed. Please try again.');
      }

      const searchJobId = data.searchJobId;
      if (!searchJobId) {
        throw new Error('Server did not return a searchJobId.');
      }

      subscribeToSearchEvents(searchJobId);
    } catch (err) {
      stopSearchTracking();
      setError(err.message || 'Network error. Is the backend running on port 5001?');
      setJobs(null);
      setSearchStatus('error');
    }
  };

  const handleReset = () => {
    stopSearchTracking();
    closeCoverLetterModal();
    setJobs(null);
    setSearchStatus('idle');
    setError('');
    setForm(initialForm);
    setIsGeneralMode(false);
    setJobTitles([]);
    setResumeFile(null);
    if (formRef.current) {
      formRef.current.reset();
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      formRef.current.querySelector('input[type="file"]')?.focus();
    }
  };

  const isLoading = searchStatus === 'loading';
  const showResults = searchStatus === 'complete' && jobs !== null;
  const showLoading = isLoading;

  return (
    <div className="app">
      <header className="app-header">
        <h1>ScouterAI</h1>
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
              <legend>אזור</legend>
              <p className="field-hint">בחר אחד או יותר. השאר ריק לכל הארץ.</p>
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
                Choose specific roles or use General to search broadly for entry-level and student positions matching your resume.
              </p>

              <button
                type="button"
                className={`general-mode-btn${isGeneralMode ? ' selected' : ''}`}
                aria-pressed={isGeneralMode}
                onClick={toggleGeneralMode}
              >
                <span className="general-mode-label-en">General / Any Matching Role</span>
                <span className="general-mode-label-he">כללי / כל משרה מתאימה</span>
              </button>

              {isGeneralMode && (
                <p className="general-mode-note" role="status">
                  Broad search enabled — JSearch will pull varied technical roles; AI will match against your resume skills.
                </p>
              )}

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
              {isLoading ? 'Analyzing jobs…' : 'Search'}
            </button>
          </form>
        </section>

        {showLoading && (
          <section
            ref={loadingRef}
            className="panel loading-panel"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="loading-indicator">
              <span className="loading-spinner" aria-hidden="true" />
              <div>
                <p className="loading-title">
                  Scanning the web and analyzing jobs with ScouterAI…
                </p>
                <p className="loading-subtitle">
                  This may take up to a minute while we search job boards and run Gemini matching against your resume.
                </p>
                <ul className="loading-steps">
                  <li>Querying JSearch with your filters</li>
                  <li>Running AI match scoring on each listing</li>
                  <li>Preparing your personalized results</li>
                </ul>
              </div>
            </div>
          </section>
        )}

        {showResults && (
          <section className="panel results-panel" aria-label="Search results">
            <h2>
              {jobs.length} match{jobs.length !== 1 ? 'es' : ''} found
            </h2>

            {jobs.length === 0 ? (
              <p>No jobs matched your filters. Try different options.</p>
            ) : (
              <ul className="job-list">
                {jobs.map((job) => (
                  <li key={job.id} className="job-card">
                    <div className="job-card-header">
                      <h3>{job.title}</h3>
                      {job.matchPercentage != null && (
                        <span className="match-badge">{job.matchPercentage}% match</span>
                      )}
                    </div>
                    <p className="job-company">{job.company}</p>
                    <dl className="job-meta">
                      {job.datePublished && (
                        <div>
                          <dt>Date published</dt>
                          <dd>{job.datePublished}</dd>
                        </div>
                      )}
                      {job.jobScope && (
                        <div>
                          <dt>Job scope</dt>
                          <dd>{job.jobScope}</dd>
                        </div>
                      )}
                      {job.location && (
                        <div>
                          <dt>Location</dt>
                          <dd>{job.location}</dd>
                        </div>
                      )}
                    </dl>
                    <div className="job-actions">
                      {job.applyLink && (
                        <a
                          className="btn-primary btn-apply"
                          href={job.applyLink}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Apply for Job
                        </a>
                      )}
                      {job.coverLetterUrl && (
                        <a
                          className="btn-secondary"
                          href={job.coverLetterUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Download Cover Letter
                        </a>
                      )}
                      {!job.coverLetterUrl && getCoverLetterText(job) && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => openCoverLetterModal(job)}
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
        )}
      </main>

      {coverLetterModal && (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={closeCoverLetterModal}
        >
          <div
            className="modal-panel cover-letter-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cover-letter-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h2 id="cover-letter-modal-title">Cover letter</h2>
                <p className="modal-subtitle">
                  {coverLetterModal.title}
                  {coverLetterModal.company ? ` · ${coverLetterModal.company}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={closeCoverLetterModal}
                aria-label="Close cover letter"
              >
                ×
              </button>
            </div>

            <textarea
              className="cover-letter-text"
              readOnly
              value={coverLetterModal.text}
              aria-label="Cover letter text"
            />

            <div className="modal-actions">
              <button type="button" className="btn-primary" onClick={downloadModalCoverLetter}>
                Download .txt
              </button>
              <button type="button" className="btn-secondary" onClick={copyCoverLetterToClipboard}>
                Copy to clipboard
              </button>
              {copyFeedback && (
                <span className="copy-feedback" role="status">
                  {copyFeedback}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

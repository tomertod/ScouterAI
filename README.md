# ScouterAI: Autonomous Job Discovery & Personalization

  ScouterAI is an end-to-end intelligent automation system designed to streamline the job hunt process. It autonomously discovers relevant job postings, analyzes their match against a user's resume using LLMs, and generates personalized cover letters.

# Features
  Intelligent Scraping: Real-time job discovery using web scraping (BeautifulSoup & requests) for local Israeli job markets, bypassing restricted API constraints.

  Resume Analysis: Uses OpenAI's GPT models to calculate match percentages and craft tailored cover letters for every unique job opening.

  Workflow Automation: Managed via Python workers, Turso database for state management, and Discord integration for instant job alerts.

## Project layout

```
Quest2/
├── backend/
│   ├── package.json
│   └── server.js
└── frontend/
    ├── package.json
    ├── public/index.html
    └── src/
        ├── App.js
        ├── App.css
        └── index.js
```

## Setup & run
Prerequisites:

  Python 3.x

  Node.js & npm

### Backend (port 5000)

```bash
cd backend
npm install
npm start
```

Installs: `express`, `cors`, `multer`.

### Frontend (port 3000, default CRA)

```bash
cd frontend
npm install
npm start
```

Installs: `react`, `react-dom`, `react-scripts`.

Open [http://localhost:3000](http://localhost:3000), fill the search panel, and submit. The app posts `multipart/form-data` to [http://localhost:5000/api/scout](http://localhost:5000/api/scout).

### Worker (The Engine)
The worker script runs the scraping and AI analysis logic:
  pip install requests beautifulsoup4 openai aiohttp
  python worker.py  

## API contract

**Request** — `POST /api/scout` (`multipart/form-data`)

| Field | Type | Description |
|-------|------|-------------|
| `resume` | file (PDF) | User resume |
| `region` | string | `South` \| `Center` \| `North` |
| `jobScope` | string | `Full-time` \| `Part-time` \| `Student` \| `Internship` \| `Temporary` |
| `jobTitle` | string | Target role title |
| `maxDatePublished` | string (optional) | ISO date — influences mock listing dates |

**Response** — `200` JSON

```json
{
  "mockJobs": [
    {
      "id": "string",
      "title": "string",
      "company": "string",
      "datePublished": "YYYY-MM-DD",
      "jobScope": "string",
      "location": "string",
      "matchPercentage": 94,
      "coverLetterUrl": "https://example.com/..."
    }
  ]
}
```

`mockJobs` is sorted by `matchPercentage` descending (highest first).

## Security Notice
  This project uses several API keys. To ensure security, sensitive information is managed via a .env file:
    OPENAI_API_KEY: For resume-to-job matching & cover letters.
    TURSO_DATABASE_URL / AUTH_TOKEN: For session management.
    DISCORD_WEBHOOK_URL: For job alert delivery.
  Always ensure your .env file is listed in .gitignore before pushing to GitHub.

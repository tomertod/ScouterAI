#!/usr/bin/env python3
"""
ScouterAI background worker.

1. Fetches pending user_preferences from Turso
2. Scrapes LinkedIn Israel job search results (title × region)
3. Deduplicates by job URL
4. Scores each job with OpenAI (gpt-4o-mini) → match_percentage + cover_letter
5. Saves results to found_jobs in Turso
6. Sends Discord webhook notifications
7. Optionally notifies the Node backend via POST /api/callback (SSE to frontend)
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
import uuid
from itertools import product
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus, urljoin

import libsql_client
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from openai import OpenAI

ROOT_DIR = Path(__file__).resolve().parent
load_dotenv(ROOT_DIR / "backend" / ".env")
load_dotenv(ROOT_DIR / ".env")

TURSO_DATABASE_URL = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "")
BACKEND_CALLBACK_URL = os.environ.get("BACKEND_CALLBACK_URL", "http://localhost:5001/api/callback")

CV_TEXT = os.environ.get(
    "CV_TEXT",
    """Computer Science student at Ben-Gurion University (second year).
Skills: Python, Java, C++, JavaScript, SQL, Git, HTML, React.
Seeking student / junior software or QA roles in Israel.""",
)

REGION_LOCATIONS: dict[str, str] = {
    "north": "Haifa, Israel",
    "haifa_krayot": "Haifa, Israel",
    "sharon": "Netanya, Israel",
    "center": "Tel Aviv, Israel",
    "jerusalem": "Jerusalem, Israel",
    "south": "Beer Sheva, Israel",
    "arava": "Arava, Israel",
    "eilat": "Eilat, Israel",
}

LINKEDIN_JOBS_BASE = "https://il.linkedin.com/jobs/search"
INDEED_JOBS_BASE = "https://il.indeed.com/jobs"
SCRAPER_RESULTS_LIMIT = 20
SCRAPER_MIN_DELAY_SEC = 1.0
SCRAPER_MAX_DELAY_SEC = 3.0
SCRAPER_TIMEOUT_SEC = 30

SCRAPER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

GENERAL_JOB_TITLES = [
    "Software Student Developer",
    "Computer Science Entry Level",
    "Junior Developer",
]


def get_db() -> libsql_client.Client:
    if not TURSO_DATABASE_URL or not TURSO_AUTH_TOKEN:
        raise RuntimeError("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN")
    return libsql_client.create_client_sync(
        url=TURSO_DATABASE_URL,
        auth_token=TURSO_AUTH_TOKEN,
    )


def parse_json_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return [str(item) for item in parsed] if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def resolve_job_titles(job_titles: list[str], search_mode: str) -> list[str]:
    if search_mode == "general" or any(t.lower() == "general" for t in job_titles):
        return GENERAL_JOB_TITLES
    return [t for t in job_titles if t.lower() != "general"]


def resolve_search_regions(region_codes: list[str]) -> list[str]:
    if not region_codes:
        return ["Israel"]

    locations: list[str] = []
    for code in region_codes:
        location = REGION_LOCATIONS.get(code)
        if location:
            locations.append(location)
            continue
        locations.append(f"{code.replace('_', ' ').title()}, Israel")

    return locations


def human_delay() -> None:
    delay = random.uniform(SCRAPER_MIN_DELAY_SEC, SCRAPER_MAX_DELAY_SEC)
    print(f"[Scraper] Sleeping {delay:.1f}s before next request")
    time.sleep(delay)


def build_linkedin_search_url(job_title: str, location: str) -> str:
    return (
        f"{LINKEDIN_JOBS_BASE}"
        f"?keywords={quote_plus(job_title)}"
        f"&location={quote_plus(location)}"
    )


def build_indeed_search_url(job_title: str, location: str) -> str:
    return (
        f"{INDEED_JOBS_BASE}"
        f"?q={quote_plus(job_title)}"
        f"&l={quote_plus(location)}"
    )


def normalize_scraped_url(href: str, base_url: str) -> str:
    href = (href or "").strip()
    if not href:
        return ""
    if href.startswith("//"):
        return f"https:{href}"
    if href.startswith("/"):
        return urljoin(base_url, href)
    return href


def normalize_date_published(value: Any) -> str:
    if not value:
        return ""
    text = str(value)
    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        return text[:10]
    return text


def fetch_user_preferences(db: libsql_client.Client, preference_id: str | None = None) -> list[dict]:
    sql = """
        SELECT
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
        FROM user_preferences
    """
    args: list[str] = []

    if preference_id:
        sql += " WHERE id = ? LIMIT 1"
        args.append(preference_id)
    else:
        sql += " WHERE status = 'pending' ORDER BY created_at ASC"

    result = db.execute(sql, args)

    rows = []
    for row in result.rows:
        rows.append(
            {
                "id": row[0],
                "regions": parse_json_list(row[1]),
                "job_scopes": parse_json_list(row[2]),
                "job_titles": parse_json_list(row[3]),
                "max_date_published": row[4],
                "resume_text": row[5] or CV_TEXT,
                "resume_file_name": row[6],
                "search_mode": row[7] or "specific",
                "jsearch_query": row[8],
                "status": row[9],
            }
        )
    return rows


def update_preference_status(db: libsql_client.Client, preference_id: str, status: str) -> None:
    db.execute(
        """
        UPDATE user_preferences
        SET status = ?, updated_at = datetime('now')
        WHERE id = ?
        """,
        [status, preference_id],
    )


def normalize_scraped_job(
    *,
    title: str,
    company: str,
    job_url: str,
    location: str,
    description: str = "",
) -> dict | None:
    title = title.strip()
    job_url = job_url.strip()
    if not title or not job_url:
        return None

    return {
        "title": title,
        "company": company.strip(),
        "location": location.strip() or "Israel",
        "description": description.strip(),
        "job_url": job_url,
        "date_published": "",
    }


def parse_linkedin_html(html: str, fallback_location: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    jobs: list[dict] = []
    seen_urls: set[str] = set()

    card_selectors = (
        "div.base-search-card",
        "li.jobs-search-results__list-item",
        "div.job-search-card",
    )
    cards: list[Any] = []
    for selector in card_selectors:
        cards.extend(soup.select(selector))

    for card in cards:
        link_el = card.select_one(
            "a.base-card__full-link, a.job-card-list__title--link, a[href*='/jobs/view/']"
        )
        title_el = card.select_one(
            "h3.base-search-card__title, h3.job-card-list__title, .job-search-card__title"
        )
        company_el = card.select_one(
            "h4.base-search-card__subtitle, h4.job-card-container__company-name, "
            ".job-search-card__subtitle"
        )
        location_el = card.select_one(
            "span.job-search-card__location, .job-card-container__metadata-item"
        )

        job_url = normalize_scraped_url(
            link_el.get("href") if link_el else "",
            "https://il.linkedin.com",
        )
        title = (title_el.get_text(strip=True) if title_el else "") or (
            link_el.get_text(strip=True) if link_el else ""
        )
        company = company_el.get_text(strip=True) if company_el else ""
        location = (
            location_el.get_text(strip=True) if location_el else fallback_location
        )

        if not job_url or job_url in seen_urls:
            continue
        seen_urls.add(job_url)

        job = normalize_scraped_job(
            title=title,
            company=company,
            job_url=job_url,
            location=location,
        )
        if job:
            jobs.append(job)

    for script in soup.find_all("script", type="application/ld+json"):
        raw_json = script.string or script.get_text()
        if not raw_json:
            continue
        try:
            payload = json.loads(raw_json)
        except json.JSONDecodeError:
            continue

        items = payload if isinstance(payload, list) else [payload]
        for item in items:
            if not isinstance(item, dict) or item.get("@type") != "JobPosting":
                continue

            job_url = normalize_scraped_url(
                str(item.get("url") or item.get("sameAs") or ""),
                "https://il.linkedin.com",
            )
            if not job_url or job_url in seen_urls:
                continue
            seen_urls.add(job_url)

            org = item.get("hiringOrganization") or {}
            company = org.get("name") if isinstance(org, dict) else str(org)

            job_location = item.get("jobLocation")
            location = fallback_location
            if isinstance(job_location, dict):
                address = job_location.get("address") or {}
                if isinstance(address, dict):
                    location = address.get("addressLocality") or location

            job = normalize_scraped_job(
                title=str(item.get("title") or ""),
                company=str(company or ""),
                job_url=job_url,
                location=str(location),
                description=str(item.get("description") or ""),
            )
            if job:
                jobs.append(job)

    return jobs[:SCRAPER_RESULTS_LIMIT]


def parse_indeed_html(html: str, fallback_location: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    jobs: list[dict] = []
    seen_urls: set[str] = set()

    cards = soup.select("div.job_seen_beacon, div.jobsearch-ResultsList > li, td.resultContent")
    for card in cards:
        title_el = card.select_one("a.jcs-JobTitle, h2.jobTitle a, a[data-jk]")
        company_el = card.select_one('[data-testid="company-name"], span.companyName')
        location_el = card.select_one('[data-testid="text-location"],div.companyLocation')

        if not title_el:
            continue

        job_url = normalize_scraped_url(title_el.get("href") or "", INDEED_JOBS_BASE)
        if job_url and "viewjob" not in job_url and title_el.get("data-jk"):
            job_url = f"{INDEED_JOBS_BASE}/viewjob?jk={title_el['data-jk']}"

        title = title_el.get_text(strip=True)
        company = company_el.get_text(strip=True) if company_el else ""
        location = (
            location_el.get_text(strip=True) if location_el else fallback_location
        )

        if not job_url or job_url in seen_urls:
            continue
        seen_urls.add(job_url)

        job = normalize_scraped_job(
            title=title,
            company=company,
            job_url=job_url,
            location=location,
        )
        if job:
            jobs.append(job)

    return jobs[:SCRAPER_RESULTS_LIMIT]


def fetch_search_html(url: str) -> str:
    response = requests.get(
        url,
        headers=SCRAPER_HEADERS,
        timeout=SCRAPER_TIMEOUT_SEC,
    )
    response.raise_for_status()
    return response.text


def scrape_jobs(job_title: str, location: str) -> list[dict]:
    """Scrape LinkedIn Israel first; fall back to Indeed Israel if no cards found."""
    linkedin_url = build_linkedin_search_url(job_title, location)
    print(f"[Scraper] Fetching LinkedIn — {linkedin_url}")

    try:
        linkedin_html = fetch_search_html(linkedin_url)
        linkedin_jobs = parse_linkedin_html(linkedin_html, fallback_location=location)
        print(
            f"[Scraper] LinkedIn returned {len(linkedin_jobs)} parsed job(s) "
            f"for title={job_title!r}, location={location!r}"
        )
        if linkedin_jobs:
            return linkedin_jobs
    except requests.RequestException as error:
        print(f"[Scraper] LinkedIn request failed — {error}")

    indeed_url = build_indeed_search_url(job_title, location)
    print(f"[Scraper] Fetching Indeed fallback — {indeed_url}")

    try:
        indeed_html = fetch_search_html(indeed_url)
        indeed_jobs = parse_indeed_html(indeed_html, fallback_location=location)
        print(
            f"[Scraper] Indeed returned {len(indeed_jobs)} parsed job(s) "
            f"for title={job_title!r}, location={location!r}"
        )
        return indeed_jobs
    except requests.RequestException as error:
        print(f"[Scraper] Indeed request failed — {error}")
        return []


def job_matches_max_date(job: dict, max_date_published: str | None) -> bool:
    min_date = (max_date_published or "").strip()
    if not min_date:
        return True

    published = (job.get("date_published") or "").strip()
    if not published:
        return True

    return published[:10] >= min_date[:10]


def collect_unique_jobs(preferences: dict) -> list[dict]:
    titles = resolve_job_titles(preferences["job_titles"], preferences["search_mode"])
    search_locations = resolve_search_regions(preferences.get("regions") or [])
    max_date_published = preferences.get("max_date_published")

    if not titles:
        print("[Scraper] No job titles to search")
        return []

    seen_urls: set[str] = set()
    unique_jobs: list[dict] = []
    combinations = list(product(titles, search_locations))

    for index, (title, location) in enumerate(combinations):
        if index > 0:
            human_delay()

        print(f"[Scraper] Searching — title={title!r}, location={location!r}")

        batch = scrape_jobs(job_title=title, location=location)

        kept = 0
        for job in batch:
            if not job_matches_max_date(job, max_date_published):
                print(
                    f"[Scraper] Filtered out — date={job.get('date_published')!r} "
                    f"(min={max_date_published!r})"
                )
                continue

            url = job.get("job_url", "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            job["search_query"] = title
            job["search_location"] = location
            unique_jobs.append(job)
            kept += 1

        print(f"[Scraper] Kept {kept}/{len(batch)} result(s) for title={title!r}, location={location!r}")

    print(
        f"[Scraper] Collected {len(unique_jobs)} unique job(s) "
        f"across {len(combinations)} title × region combination(s)"
    )
    return unique_jobs


def analyze_job_with_openai(job: dict, cv_text: str) -> dict:
    if not OPENAI_API_KEY:
        raise RuntimeError("Set OPENAI_API_KEY")

    client = OpenAI(api_key=OPENAI_API_KEY)
    description = (job.get("description") or "").strip()
    description_block = description or (
        "No description scraped — infer role details from title, company, and location."
    )

    prompt = f"""You are a career matching assistant.

Compare the candidate CV with the job posting and respond ONLY with valid JSON:
{{
  "match_percentage": <integer 0-100>,
  "cover_letter": "<short tailored cover letter, max 200 words>"
}}

CV:
{cv_text}

Job title: {job.get('title', '')}
Company: {job.get('company', '')}
Location: {job.get('location', '')}
Description:
{description_block}
"""

    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        response_format={"type": "json_object"},
        messages=[
            {
                "role": "system",
                "content": "Return strict JSON with match_percentage and cover_letter keys only.",
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.3,
    )

    content = completion.choices[0].message.content or "{}"
    parsed = json.loads(content)
    return {
        "match_percentage": int(parsed.get("match_percentage", 0)),
        "cover_letter": str(parsed.get("cover_letter", "")).strip(),
    }


def save_found_job(
    db: libsql_client.Client,
    preference_id: str,
    job: dict,
    analysis: dict,
) -> None:
    db.execute(
        """
        INSERT INTO found_jobs (
          id,
          preference_id,
          title,
          company,
          location,
          job_url,
          description,
          date_published,
          match_percentage,
          cover_letter
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_url) DO UPDATE SET
          match_percentage = excluded.match_percentage,
          cover_letter = excluded.cover_letter,
          preference_id = excluded.preference_id
        """,
        [
            str(uuid.uuid4()),
            preference_id,
            job.get("title"),
            job.get("company"),
            job.get("location"),
            job.get("job_url"),
            job.get("description"),
            job.get("date_published"),
            analysis.get("match_percentage"),
            analysis.get("cover_letter"),
        ],
    )


def truncate_text(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 3].rstrip() + "..."


def match_embed_color(match_percentage: int) -> int:
    if match_percentage >= 80:
        return 0x008009
    if match_percentage >= 60:
        return 0x0071C2
    return 0xF5A623


def send_discord_notification(job: dict, analysis: dict) -> None:
    if not DISCORD_WEBHOOK_URL:
        print("[Discord] Skipped — DISCORD_WEBHOOK_URL not set")
        return

    match_percentage = analysis.get("match_percentage", 0)
    apply_url = (job.get("job_url") or "").strip()
    cover_letter = analysis.get("cover_letter", "").strip()
    company = job.get("company") or "Unknown company"
    location = job.get("location") or "Israel"
    title = job.get("title") or "New job match"

    apply_line = (
        f"[Apply for this role]({apply_url})"
        if apply_url
        else "_No apply link available_"
    )
    cover_letter_block = truncate_text(cover_letter or "_No cover letter generated_", 1800)

    embed = {
        "title": title,
        "url": apply_url or None,
        "color": match_embed_color(match_percentage),
        "author": {"name": "ScouterAI • New Job Match"},
        "fields": [
            {"name": "Company", "value": company, "inline": True},
            {"name": "Match score", "value": f"**{match_percentage}%**", "inline": True},
            {"name": "Location", "value": location, "inline": True},
            {"name": "Apply", "value": apply_line, "inline": False},
            {
                "name": "Cover letter",
                "value": f"```\n{cover_letter_block}\n```",
                "inline": False,
            },
        ],
        "footer": {"text": "ScouterAI job scout"},
    }

    if not embed["url"]:
        del embed["url"]

    response = requests.post(
        DISCORD_WEBHOOK_URL,
        json={
            "username": "ScouterAI",
            "avatar_url": "https://cdn.discordapp.com/embed/avatars/0.png",
            "embeds": [embed],
        },
        timeout=30,
    )
    response.raise_for_status()
    print(f"[Discord] Notification sent for {title} @ {company}")


def notify_backend_callback(preference_id: str, jobs: list[dict]) -> None:
    if not BACKEND_CALLBACK_URL:
        return

    payload = {
        "searchJobId": preference_id,
        "jobs": [
            {
                "id": job.get("id") or str(uuid.uuid4()),
                "title": job.get("title"),
                "company": job.get("company"),
                "location": job.get("location"),
                "datePublished": job.get("date_published"),
                "matchPercentage": job.get("match_percentage"),
                "applyLink": job.get("job_url"),
                "coverLetter": job.get("cover_letter"),
            }
            for job in jobs
        ],
    }

    try:
        response = requests.post(BACKEND_CALLBACK_URL, json=payload, timeout=30)
        response.raise_for_status()
        print(f"[Backend] Callback delivered to {BACKEND_CALLBACK_URL}")
    except requests.RequestException as error:
        print(f"[Backend] Callback failed: {error}")


def process_preference(db: libsql_client.Client, preferences: dict) -> None:
    preference_id = preferences["id"]
    cv_text = preferences.get("resume_text") or CV_TEXT

    print(f"[Worker] Processing preference {preference_id}")
    update_preference_status(db, preference_id, "processing")

    unique_jobs = collect_unique_jobs(preferences)
    analyzed_results: list[dict] = []

    for job in unique_jobs:
        print(f"[OpenAI] Analyzing: {job.get('title')} @ {job.get('company')}")
        try:
            analysis = analyze_job_with_openai(job, cv_text)
        except Exception as error:
            print(f"[OpenAI] Failed for {job.get('job_url')}: {error}")
            continue

        save_found_job(db, preference_id, job, analysis)
        send_discord_notification(job, analysis)

        analyzed_results.append(
            {
                **job,
                "match_percentage": analysis["match_percentage"],
                "cover_letter": analysis["cover_letter"],
            }
        )

    analyzed_results.sort(key=lambda item: item.get("match_percentage", 0), reverse=True)
    update_preference_status(db, preference_id, "completed")
    notify_backend_callback(preference_id, analyzed_results)

    print(
        f"[Worker] Completed preference {preference_id} — "
        f"{len(analyzed_results)} analyzed job(s)"
    )


def run_worker(preference_id: str | None = None) -> None:
    db = get_db()
    preferences_list = fetch_user_preferences(db, preference_id)

    if not preferences_list:
        print("[Worker] No pending preferences found")
        return

    for preferences in preferences_list:
        if preferences.get("status") not in (None, "pending", "processing"):
            continue
        process_preference(db, preferences)


if __name__ == "__main__":
    target_id = sys.argv[1] if len(sys.argv) > 1 else None
    run_worker(target_id)

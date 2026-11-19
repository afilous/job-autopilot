# Job Autopilot

Finds Strategy & Operations, Business Operations, Chief of Staff, Partner Ops and
GTM/Rev Ops roles (SF Bay Area onsite/hybrid, or remote US), scores them, and
stores them in Supabase. Applications are queued and submitted through Tsenta
(or directly via `submit.js`). Everything runs free: GitHub Actions plus free API tiers.

## How it fits together

```
 job sources ──► discover-*.js ──► Supabase `applications` ──► triggers set fit_tier / apply_path
                                                          └──► Tsenta (apply) / submit.js
```

Scoring lives in `lib/scoring.js`; the tiers (apply / review / skip) are assigned by
the Supabase function `classify_job`. Every script writes a row to `run_log`.

## Workflows (`.github/workflows`)

| Workflow | When (UTC) | What it does | Needs |
|---|---|---|---|
| `discover-jobs.yml` | weekdays 16:00 | ATS board APIs (free), plus Adzuna / JSearch / SerpApi (Mon + Thu only) | Supabase, optional API keys |
| `discover-jobs-google.yml` | Mon + Thu 16:00 | Site-scoped web search of ATS boards, past week, results merged from Tavily + Bright Data, with backups | see Secrets |
| `discover-jobs-workday.yml` | weekdays 16:30 | Workday tenants (Visa, etc.) | Supabase |
| `discover-newsletters.yml` | daily 15:30 | Reads startup job newsletters on Substack, adds their job boards to `companies` | Supabase |
| `discover-companies.yml` | 1st + 15th 06:00 | Finds new company job boards (SerpApi site search) | SerpApi |
| `resolve-linkedin.yml` | every 6 h | Turns LinkedIn / aggregator links into direct employer apply links | Supabase |
| `monitor-gmail.yml` | scheduled | Reads application emails | Gmail |
| `submit-jobs.yml` | nightly | Submits queued applications with Playwright | Supabase, Gemini |
| `cleanup.yml` | Sundays | Archives old rows, updates polling tiers | Supabase |

Every discovery workflow has a **Dry run** option on "Run workflow": it prints what
it would save and writes nothing.

## Secrets (Settings → Secrets and variables → Actions)

| Secret | Used by | Free tier |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | everything | free |
| `TAVILY_API_KEY` | web search | 1,000 credits/month, no card |
| `BRIGHTDATA_API_KEY`, `BRIGHTDATA_ZONE` | web search | 5,000/month, shared pool |
| `SERPAPI_KEY` | web search (backup), job search, company discovery | 250/month |
| `SERPER_API_KEY` | web search (backup) | 2,500 one-time, never renews |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `RAPIDAPI_KEY` | job search (optional) | free tiers |
| `GEMINI_API_KEY` | submit | free tier |

## Staying on free credits

Every paid-if-exceeded search call goes through `lib/quota.js`, which counts usage
in Supabase and refuses a call once the free limit (minus a safety reserve) is
reached. Check what is left any time:

```sql
select * from api_quota_status;
```

Monthly plans reset on the 1st; one-time credits (Serper) never reset. If a
dashboard shows different usage, correct `used` in the `api_quota` table.

## Useful Supabase views

`job_inbox` (what to look at), `job_inbox_summary`, `source_health` (is each source
still producing jobs), `api_quota_status`, and the table `tsenta_unsupported_log`
(jobs Tsenta can't apply to).

## Conventions

- Scripts are plain Node (`node discover-*.js`), configured only by environment variables.
- A run where every call failed must fail the workflow (never look green).
- Add a newsletter: insert a row in `job_newsletters` (name, feed_url). No code change.

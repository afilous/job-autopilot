# Job Autopilot — GitHub Actions Setup

## What this does
Runs every night at midnight PT. Reads queued jobs from Supabase, 
fills and submits each application form using Playwright, 
then updates the status back in Supabase.

## Setup (5 minutes)

### Step 1 — Add these files to your repo
Upload these files to github.com/afilous/job-autopilot:
- `.github/workflows/submit-jobs.yml`
- `scripts/submit.js`
- `scripts/package.json`

### Step 2 — Add secrets to GitHub
Go to: github.com/afilous/job-autopilot/settings/secrets/actions
Click "New repository secret" for each:

| Secret name | Value |
|---|---|
| `SUPABASE_URL` | `https://xvmjgyninryegrkfryma.supabase.co` |
| `SUPABASE_ANON_KEY` | `sb_publishable_-OBN-INxURCAr20zzq-8oQ_-aEf3L1t` |
| `GEMINI_API_KEY` | your Gemini API key from Settings tab in the app |

### Step 3 — Test it manually
Go to: github.com/afilous/job-autopilot/actions
Click "Job Autopilot — Submit Applications"
Click "Run workflow" → "Run workflow"
Watch the logs in real time

### Step 4 — It runs automatically
Every night at 7am UTC (midnight PT), it will:
1. Read all queued jobs with AI answers from Supabase
2. Open each job application page in a headless browser
3. Fill the form with your profile + AI answers
4. Submit
5. Update status to submitted/failed in Supabase
6. Save a run log as a downloadable artifact

## Monitoring
- Go to github.com/afilous/job-autopilot/actions to see every run
- Click any run to see detailed logs
- Download the run-log.json artifact for a summary
- Your YouWare app will show updated statuses automatically

## Schedule
Current: 7am UTC = midnight PT daily
To change: edit the cron line in .github/workflows/submit-jobs.yml
Cron format: minute hour day month weekday
Examples:
- `0 7 * * *` = midnight PT (7am UTC) every day
- `0 14 * * 1-5` = 6am PT weekdays only
- `0 7 * * 1` = midnight PT every Monday

## Dry run (test without submitting)
Add `--dry-run` to the run command in submit-jobs.yml:
`node submit.js --dry-run`
This reads jobs and logs what it would do without actually submitting.

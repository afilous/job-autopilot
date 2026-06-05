/**
 * Job Autopilot — Daily Job Discovery
 * Sources: Adzuna (primary) + JSearch (secondary) + SerpApi (tertiary)
 * Filters for Greenhouse, Lever, and Ashby ATS URLs only
 * Inserts new jobs directly into Supabase applications table
 */

const { createClient } = require('@supabase/supabase-js');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const JSEARCH_API_KEY = process.env.JSEARCH_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Search queries targeting your role ───────────────────────────────────────
const QUERIES = [
  // Strategy & Operations
  'strategy operations manager San Francisco',
  'strategy and operations manager',
  'strategic operations manager San Francisco',
  'senior strategy operations manager',
  'director strategy operations San Francisco',
  // Business Operations
  'business operations manager San Francisco',
  'BizOps manager San Francisco',
  'business operations lead',
  'business operations analyst San Francisco',
  'senior business operations manager',
  'director business operations San Francisco',
  // GTM & Revenue Operations
  'GTM operations manager remote',
  'go to market operations manager',
  'revenue operations manager San Francisco',
  'RevOps manager San Francisco',
  'sales operations manager San Francisco',
  'sales strategy and operations manager',
  'commercial operations manager',
  // Chief of Staff
  'chief of staff San Francisco',
  'chief of staff startup remote',
  // Program Management
  'program manager strategy operations',
  'senior program manager operations San Francisco',
  'strategic program manager San Francisco',
  // Strategy & Planning
  'strategy analyst San Francisco',
  'strategy manager San Francisco',
  'strategy lead San Francisco',
  'strategic initiatives manager',
  'strategic planning manager San Francisco',
  'corporate strategy manager',
  'growth strategy manager',
  'business strategy manager San Francisco',
  // Operations
  'senior operations manager San Francisco',
  'director of operations San Francisco',
  'special projects manager San Francisco',
];

// ── ATS URL patterns ──────────────────────────────────────────────────────────
const ATS_PATTERNS = [
  { regex: /boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/, ats_type: 'greenhouse' },
  { regex: /job-boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/, ats_type: 'greenhouse' },
  { regex: /jobs\.lever\.co\/([^/]+)\/([a-f0-9-]{36})/, ats_type: 'lever' },
  { regex: /jobs\.ashbyhq\.com\/([^/]+)\/([a-f0-9-]{36})/, ats_type: 'ashby' },
];

function parseAtsUrl(url) {
  if (!url) return null;
  for (const { regex, ats_type } of ATS_PATTERNS) {
    const match = url.match(regex);
    if (match) {
      return {
        ats_type,
        ats_slug: match[1].toLowerCase(),
        external_id: match[2],
        url: url.split('?')[0],
      };
    }
  }
  return null;
}

// Also try to extract ATS info from any string (including job descriptions)
function extractAtsFromText(text) {
  if (!text) return null;
  const urlMatches = text.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  for (const u of urlMatches) {
    const info = parseAtsUrl(u);
    if (info) return info;
  }
  return null;
}

// ── Deduplicate and insert jobs ───────────────────────────────────────────────
async function insertJobs(jobs) {
  if (jobs.length === 0) return 0;

  // Get existing external_ids to avoid duplicates
  const externalIds = jobs.map(j => j.external_id).filter(Boolean);
  const { data: existing } = await supabase
    .from('applications')
    .select('external_id')
    .in('external_id', externalIds);

  const existingIds = new Set((existing || []).map(e => e.external_id));
  const newJobs = jobs.filter(j => j.external_id && !existingIds.has(j.external_id));

  if (newJobs.length === 0) return 0;

  const { error } = await supabase.from('applications').insert(
    newJobs.map(j => ({
      job_title: j.job_title,
      company: j.company,
      ats_type: j.ats_type,
      ats_slug: j.ats_slug,
      external_id: j.external_id,
      url: j.url,
      status: 'queued',
      match_score: 0, // will be scored by AI later
      source: j.source,
    }))
  );

  if (error) {
    log(`  ❌ Insert error: ${error.message}`);
    return 0;
  }

  return newJobs.length;
}

// ── Source 1: Adzuna ──────────────────────────────────────────────────────────
async function fetchAdzuna() {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    log('⏭ Adzuna: no credentials, skipping');
    return [];
  }

  log('🔍 Adzuna: fetching jobs...');
  const jobs = [];

  for (const query of QUERIES) {
    try {
      const params = new URLSearchParams({
        app_id: ADZUNA_APP_ID,
        app_key: ADZUNA_APP_KEY,
        results_per_page: '50',
        what: query,
        max_days_old: '14',
        sort_by: 'date',
      });

      const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { log(`  ⚠ Adzuna ${res.status} for: ${query}`); continue; }

      const data = await res.json();
      const results = data.results || [];

      for (const job of results) {
        // Adzuna returns a redirect URL, not always the direct ATS URL
        // Try the redirect_url and adref fields
        const candidateUrls = [
          job.redirect_url,
          job.adref,
          ...(job.apply_url ? [job.apply_url] : []),
        ].filter(Boolean);

        let atsInfo = null;
        for (const u of candidateUrls) {
          atsInfo = parseAtsUrl(u);
          if (atsInfo) break;
        }

        // Also check the description for ATS URLs
        if (!atsInfo && job.description) {
          const urlMatches = job.description.match(/https?:\/\/[^\s"'<>]+/g) || [];
          for (const u of urlMatches) {
            atsInfo = parseAtsUrl(u);
            if (atsInfo) break;
          }
        }

        if (atsInfo) {
          jobs.push({
            job_title: job.title,
            company: job.company?.display_name || atsInfo.ats_slug,
            source: 'adzuna',
            ...atsInfo,
          });
        }
      }

      log(`  ✓ "${query}" → ${results.length} results, ${jobs.length} ATS matches so far`);
      await sleep(500);

    } catch (e) {
      log(`  ⚠ Adzuna error for "${query}": ${e.message}`);
    }
  }

  // Also run remote-only searches
  const remoteQueries = [
    'strategy operations manager',
    'chief of staff',
    'GTM operations remote',
    'BizOps manager remote',
  ];

  for (const query of remoteQueries) {
    try {
      const params = new URLSearchParams({
        app_id: ADZUNA_APP_ID,
        app_key: ADZUNA_APP_KEY,
        results_per_page: '50',
        what: query,
        max_days_old: '14',
        sort_by: 'date',
      });

      const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;

      const data = await res.json();
      const results = data.results || [];

      for (const job of results) {
        const candidateUrls = [job.redirect_url, job.adref].filter(Boolean);
        let atsInfo = null;
        for (const u of candidateUrls) {
          atsInfo = parseAtsUrl(u);
          if (atsInfo) break;
        }
        if (atsInfo) {
          jobs.push({
            job_title: job.title,
            company: job.company?.display_name || atsInfo.ats_slug,
            source: 'adzuna',
            ...atsInfo,
          });
        }
      }

      await sleep(500);
    } catch (e) {}
  }

  log(`✅ Adzuna: found ${jobs.length} ATS jobs`);
  return jobs;
}

// ── Source 2: JSearch (RapidAPI) ──────────────────────────────────────────────
async function fetchJSearch() {
  if (!JSEARCH_API_KEY) {
    log('⏭ JSearch: no credentials, skipping');
    return [];
  }

  log('🔍 JSearch: fetching jobs...');
  const jobs = [];

  const jsearchQueries = [
    'strategy operations manager San Francisco',
    'chief of staff San Francisco OR remote',
    'GTM operations director remote',
    'business operations manager San Francisco',
  ];

  for (const query of jsearchQueries) {
    try {
      const params = new URLSearchParams({
        query,
        page: '1',
        num_pages: '1',
        date_posted: 'week',
      });

      const res = await fetch(`https://jsearch.p.rapidapi.com/search?${params}`, {
        headers: {
          'X-RapidAPI-Key': JSEARCH_API_KEY,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) { log(`  ⚠ JSearch ${res.status}`); continue; }

      const data = await res.json();
      const results = data.data || [];

      for (const job of results) {
        const candidateUrls = [
          job.job_apply_link,
          job.job_google_link,
          job.job_url,
          ...(job.apply_options || []).map(o => o.apply_link),
        ].filter(Boolean);

        let atsInfo = null;
        for (const u of candidateUrls) {
          atsInfo = parseAtsUrl(u);
          if (atsInfo) break;
        }

        // Also check description and other text fields
        if (!atsInfo) {
          atsInfo = extractAtsFromText(job.job_description) ||
                    extractAtsFromText(job.job_highlights?.join(' ') || '');
        }

        if (atsInfo) {
          jobs.push({
            job_title: job.job_title,
            company: job.employer_name || atsInfo.ats_slug,
            source: 'jsearch',
            ...atsInfo,
          });
        }
      }

      log(`  ✓ JSearch "${query}" → ${results.length} results`);
      await sleep(1000);

    } catch (e) {
      log(`  ⚠ JSearch error: ${e.message}`);
    }
  }

  log(`✅ JSearch: found ${jobs.length} ATS jobs`);
  return jobs;
}

// ── Source 3: SerpApi ─────────────────────────────────────────────────────────
async function fetchSerpApi() {
  if (!SERPAPI_KEY) {
    log('⏭ SerpApi: no credentials, skipping');
    return [];
  }

  log('🔍 SerpApi: fetching jobs...');
  const jobs = [];

  const serpQueries = [
    'strategy operations manager San Francisco',
    'chief of staff startup San Francisco',
    'RevOps GTM operations remote',
  ];

  for (const query of serpQueries) {
    try {
      const params = new URLSearchParams({
        engine: 'google_jobs',
        q: query,
        chips: 'date_posted:week',
        api_key: SERPAPI_KEY,
      });

      const res = await fetch(`https://serpapi.com/search?${params}`, {
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) { log(`  ⚠ SerpApi ${res.status}`); continue; }

      const data = await res.json();
      const results = data.jobs_results || [];

      for (const job of results) {
        const applyLinks = (job.apply_options || []).map(o => o.link);
        const candidateUrls = [job.job_id, ...applyLinks].filter(Boolean);

        let atsInfo = null;
        for (const u of candidateUrls) {
          atsInfo = parseAtsUrl(u);
          if (atsInfo) break;
        }

        if (atsInfo) {
          jobs.push({
            job_title: job.title,
            company: job.company_name || atsInfo.ats_slug,
            source: 'serpapi',
            ...atsInfo,
          });
        }
      }

      log(`  ✓ SerpApi "${query}" → ${results.length} results`);
      await sleep(1000);

    } catch (e) {
      log(`  ⚠ SerpApi error: ${e.message}`);
    }
  }

  log(`✅ SerpApi: found ${jobs.length} ATS jobs`);
  return jobs;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('🚀 Starting daily job discovery...');

  // Fetch from all three sources
  const [adzunaJobs, jsearchJobs, serpApiJobs] = await Promise.allSettled([
    fetchAdzuna(),
    fetchJSearch(),
    fetchSerpApi(),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

  // Combine and deduplicate by external_id
  const allJobs = [...adzunaJobs, ...jsearchJobs, ...serpApiJobs];
  const seenIds = new Set();
  const uniqueJobs = allJobs.filter(j => {
    if (!j.external_id || seenIds.has(j.external_id)) return false;
    seenIds.add(j.external_id);
    return true;
  });

  log(`\n📊 Total unique ATS jobs found: ${uniqueJobs.length}`);
  log(`   Greenhouse: ${uniqueJobs.filter(j => j.ats_type === 'greenhouse').length}`);
  log(`   Lever:      ${uniqueJobs.filter(j => j.ats_type === 'lever').length}`);
  log(`   Ashby:      ${uniqueJobs.filter(j => j.ats_type === 'ashby').length}`);

  // Insert into Supabase
  const inserted = await insertJobs(uniqueJobs);

  log(`\n✅ Inserted ${inserted} new jobs into queue`);
  log(`⏭ Skipped ${uniqueJobs.length - inserted} already existing`);
}

main().catch(err => {
  log(`💥 Fatal: ${err.message}`);
  process.exit(1);
});

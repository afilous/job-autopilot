/**
 * Job Autopilot — Search-based Job Discovery
 * Sources: Adzuna + JSearch + SerpApi (+ optional SerpApi site: search)
 * Scores jobs at insert time using the shared engine in lib/scoring.js
 */

const { createClient } = require('@supabase/supabase-js');
const { scoreJob } = require('./lib/scoring');
const { guessAtsType, guessCompanySlug, looksLikeJobUrl } = require('./lib/url-capture');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const JSEARCH_API_KEY = process.env.JSEARCH_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

// COST GATE: the site: search adds 28 SerpApi calls per run (7 domains x 4
// title groups). On SerpApi's free plan (250 searches/month, 50/hour cap),
// combined with the 4 calls/day fetchSerpApi() already uses, running this
// daily would consume ~960 searches/month -- nearly 4x the entire free
// monthly allowance, exhausted in about 8 days. Defaults to OFF. Set
// ENABLE_SITE_SEARCH=true as a workflow input/env var only on runs where
// you deliberately want it (e.g. a manual, occasional trigger), not on the
// daily schedule, until you're on a paid plan with headroom for it.
const ENABLE_SITE_SEARCH = process.env.ENABLE_SITE_SEARCH === 'true';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Generic ATS URL parsing ───────────────────────────────────────────────────

function parseJobUrl(url) {
  if (!looksLikeJobUrl(url)) return null;
  return {
    ats_type: guessAtsType(url),
    ats_slug: guessCompanySlug(url),
    url: url.split('?')[0],
  };
}

// ── Search queries (Adzuna) ────────────────────────────────────────────────────

const QUERIES = [
  'strategy and operations manager San Francisco',
  'business operations manager San Francisco',
  'strategic operations manager',
  'revenue operations manager San Francisco',
  'GTM operations manager remote',
  'chief of staff startup San Francisco',
  'chief of staff remote startup',
  'sales strategy operations manager',
  'bizops manager San Francisco',
  'go to market operations director',
  'director strategy operations San Francisco',
  'head of operations strategy startup',
  'special projects manager San Francisco',
  'strategic initiatives manager',
  'growth operations manager remote',
  'sales operations manager San Francisco',
  'commercial operations manager San Francisco',
  'program manager strategy operations',
  'strategic planning manager San Francisco',
  'business strategy manager San Francisco',
];

// ── Adzuna ────────────────────────────────────────────────────────────────────

async function fetchAdzuna() {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) { log('⏭ Adzuna: no credentials'); return []; }
  log('🔍 Adzuna: fetching jobs...');
  const jobs = [];

  for (const query of QUERIES) {
    try {
      const params = new URLSearchParams({
        app_id: ADZUNA_APP_ID, app_key: ADZUNA_APP_KEY,
        results_per_page: '50', what: query, max_days_old: '14', sort_by: 'date',
      });
      const res = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { log(`  ⚠ Adzuna ${res.status} for: ${query}`); continue; }
      const data = await res.json();

      for (const job of (data.results || [])) {
        const candidateUrls = [job.redirect_url, job.adref, job.apply_url].filter(Boolean);
        let atsInfo = null;
        for (const u of candidateUrls) { atsInfo = parseJobUrl(u); if (atsInfo) break; }
        if (!atsInfo && job.description) {
          const urlMatches = job.description.match(/https?:\/\/[^\s"'<>]+/g) || [];
          for (const u of urlMatches) { atsInfo = parseJobUrl(u); if (atsInfo) break; }
        }
        if (!atsInfo) continue;

        const title = job.title || '';
        const location = job.location?.display_name || '';
        const company = job.company?.display_name || atsInfo.ats_slug;
        const description = job.description || '';
        const score = scoreJob({ title, department: '', description, location, company }, { strict: true });
        if (score > 0) jobs.push({ job_title: title, company, source: 'adzuna', match_score: score, ...atsInfo, location });
      }

      log(`  ✓ "${query}" → ${(data.results||[]).length} results`);
      await sleep(500);
    } catch(e) { log(`  ⚠ Adzuna error: ${e.message}`); }
  }

  log(`✅ Adzuna: ${jobs.length} relevant ATS jobs`);
  return jobs;
}

// ── JSearch ───────────────────────────────────────────────────────────────────

async function fetchJSearch() {
  if (!JSEARCH_API_KEY) { log('⏭ JSearch: no credentials'); return []; }
  log('🔍 JSearch: fetching jobs...');
  const jobs = [];

  const jsearchQueries = [
    'strategy operations manager San Francisco',
    'chief of staff startup remote',
    'GTM operations director remote',
    'business operations manager Bay Area',
    'revenue operations manager startup',
    'sales strategy operations manager',
  ];

  for (const query of jsearchQueries) {
    try {
      const params = new URLSearchParams({ query, page: '1', num_pages: '1', date_posted: 'week' });
      const res = await fetch(`https://jsearch.p.rapidapi.com/search?${params}`, {
        headers: { 'X-RapidAPI-Key': JSEARCH_API_KEY, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const data = await res.json();

      for (const job of (data.data || [])) {
        const candidateUrls = [job.job_apply_link, job.job_google_link, job.job_url, ...(job.apply_options||[]).map(o=>o.apply_link)].filter(Boolean);
        let atsInfo = null;
        for (const u of candidateUrls) { atsInfo = parseJobUrl(u); if (atsInfo) break; }
        if (!atsInfo) continue;

        const title = job.job_title || '';
        const location = `${job.job_city || ''} ${job.job_state || ''} ${job.job_country || ''}`.trim();
        const company = job.employer_name || atsInfo.ats_slug;
        const description = job.job_description || '';
        const score = scoreJob({ title, department: '', description, location, company }, { strict: true });
        if (score > 0) jobs.push({ job_title: title, company, source: 'jsearch', match_score: score, ...atsInfo, location });
      }

      log(`  ✓ JSearch "${query}"`);
      await sleep(1000);
    } catch(e) { log(`  ⚠ JSearch error: ${e.message}`); }
  }

  log(`✅ JSearch: ${jobs.length} relevant ATS jobs`);
  return jobs;
}

// ── SerpApi (google_jobs — structured job listings) ───────────────────────────
// 4 calls/day = ~120/month on its own -- roughly half the free plan's 250/month.

async function fetchSerpApi() {
  if (!SERPAPI_KEY) { log('⏭ SerpApi: no credentials'); return []; }
  log('🔍 SerpApi: fetching jobs...');
  const jobs = [];

  const serpQueries = [
    'strategy operations manager San Francisco startup',
    'chief of staff startup Bay Area OR remote',
    'GTM revenue operations director remote',
    'business operations manager startup remote',
  ];

  for (const query of serpQueries) {
    try {
      const params = new URLSearchParams({ engine: 'google_jobs', q: query, chips: 'date_posted:week', api_key: SERPAPI_KEY });
      const res = await fetch(`https://serpapi.com/search?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();

      for (const job of (data.jobs_results || [])) {
        const applyLinks = (job.apply_options||[]).map(o=>o.link);
        const candidateUrls = [job.job_id, ...applyLinks].filter(Boolean);
        let atsInfo = null;
        for (const u of candidateUrls) { atsInfo = parseJobUrl(u); if (atsInfo) break; }
        if (!atsInfo) continue;

        const title = job.title || '';
        const location = job.location || '';
        const company = job.company_name || atsInfo.ats_slug;
        const description = job.description || '';
        const score = scoreJob({ title, department: '', description, location, company }, { strict: true });
        if (score > 0) jobs.push({ job_title: title, company, source: 'serpapi', match_score: score, ...atsInfo, location });
      }

      log(`  ✓ SerpApi "${query}"`);
      await sleep(1000);
    } catch(e) { log(`  ⚠ SerpApi error: ${e.message}`); }
  }

  log(`✅ SerpApi: ${jobs.length} relevant ATS jobs`);
  return jobs;
}

// ── SerpApi site:-restricted search across ATS platforms (GATED — see ENABLE_SITE_SEARCH above) ──
// Uses the `google` engine (not `google_jobs`) so the site: operator works.
// 28 calls/run. On the free plan, do NOT run this daily -- see cost note above.

const ATS_SITE_DOMAINS = [
  'jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io',
  'jobs.lever.co', 'jobs.smartrecruiters.com', 'apply.workable.com', 'jobs.workable.com',
];

const SITE_SEARCH_TITLE_GROUPS = [
  '"strategy and operations" OR "strategy & operations" OR "business operations manager"',
  '"chief of staff" OR "biz ops" OR "bizops"',
  '"revenue operations manager" OR "gtm operations" OR "sales strategy and operations"',
  '"product operations" OR "growth operations" OR "commercial operations manager"',
];

async function fetchSerpApiSiteSearch() {
  if (!SERPAPI_KEY) { log('⏭ SerpApi site search: no credentials'); return []; }
  if (!ENABLE_SITE_SEARCH) {
    log('⏭ SerpApi site search: disabled (set ENABLE_SITE_SEARCH=true to run — costs 28 calls, see cost note in file header)');
    return [];
  }
  log('🔍 SerpApi: site-restricted search...');
  const jobs = [];

  for (const domain of ATS_SITE_DOMAINS) {
    for (const titleGroup of SITE_SEARCH_TITLE_GROUPS) {
      try {
        const q = `site:${domain} ${titleGroup}`;
        const params = new URLSearchParams({ engine: 'google', q, num: '20', api_key: SERPAPI_KEY });
        const res = await fetch(`https://serpapi.com/search?${params}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const data = await res.json();
        const organic = data.organic_results || [];

        for (const r of organic) {
          const atsInfo = parseJobUrl(r.link);
          if (!atsInfo) continue;
          const title = r.title || '';
          const snippet = r.snippet || '';
          const score = scoreJob({ title, department: '', description: snippet, location: '', company: atsInfo.ats_slug }, { strict: true });
          if (score > 0) {
            jobs.push({ job_title: title, company: atsInfo.ats_slug, source: 'serpapi-site-search', match_score: score, ...atsInfo, location: '' });
          }
        }
        log(`  ✓ site:${domain} "${titleGroup.slice(0, 30)}..." → ${organic.length} hits`);
        await sleep(1200);
      } catch (e) {
        log(`  ⚠ Site search error: ${e.message}`);
      }
    }
  }

  log(`✅ SerpApi site search: ${jobs.length} relevant ATS jobs`);
  return jobs;
}

// ── Insert jobs ───────────────────────────────────────────────────────────────

async function insertJobs(jobs) {
  if (jobs.length === 0) return { inserted: 0, archived: 0 };

  const urls = jobs.map(j => j.url).filter(Boolean);
  const { data: existing } = await supabase.from('applications').select('url').in('url', urls);
  const existingUrls = new Set((existing || []).map(e => e.url));
  const newJobs = jobs.filter(j => j.url && !existingUrls.has(j.url));
  if (newJobs.length === 0) return { inserted: 0, archived: 0 };

  const toQueue = newJobs.filter(j => j.match_score >= 75);
  const toArchive = newJobs.filter(j => j.match_score > 0 && j.match_score < 75);

  let inserted = 0;
  if (toQueue.length > 0) {
    const { error } = await supabase.from('applications').insert(
      toQueue.map(j => ({
        job_title: j.job_title, company: j.company, ats_type: j.ats_type,
        ats_slug: j.ats_slug, external_id: j.url, url: j.url,
        location: j.location || '', status: 'queued', match_score: j.match_score, source: j.source,
      }))
    );
    if (!error) inserted = toQueue.length;
    else log(`  ❌ Insert error: ${error.message}`);
  }

  if (toArchive.length > 0) {
    await supabase.from('applications').insert(
      toArchive.map(j => ({
        job_title: j.job_title, company: j.company, ats_type: j.ats_type,
        ats_slug: j.ats_slug, external_id: j.url, url: j.url,
        location: j.location || '', status: 'archived', match_score: j.match_score, source: j.source,
      }))
    ).catch(() => {});
  }

  return { inserted, archived: toArchive.length };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('🚀 Starting search-based job discovery with inline scoring...');
  log(ENABLE_SITE_SEARCH
    ? '⚠ ENABLE_SITE_SEARCH=true — running the 28-call site search this run'
    : 'ℹ Site search disabled by default (ENABLE_SITE_SEARCH not set to true)');

  const [adzunaJobs, jsearchJobs, serpApiJobs, siteSearchJobs] = await Promise.allSettled([
    fetchAdzuna(), fetchJSearch(), fetchSerpApi(), fetchSerpApiSiteSearch(),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

  const allJobs = [...adzunaJobs, ...jsearchJobs, ...serpApiJobs, ...siteSearchJobs];
  const seen = new Set();
  const uniqueJobs = allJobs.filter(j => {
    if (!j.url || seen.has(j.url)) return false;
    seen.add(j.url); return true;
  });

  log(`\n📊 Scored jobs found: ${uniqueJobs.length}`);
  log(`   Score 90+: ${uniqueJobs.filter(j => j.match_score >= 90).length}`);
  log(`   Score 82-89: ${uniqueJobs.filter(j => j.match_score >= 82 && j.match_score < 90).length}`);
  log(`   Score 75-81: ${uniqueJobs.filter(j => j.match_score >= 75 && j.match_score < 82).length}`);

  const { inserted, archived } = await insertJobs(uniqueJobs);
  log(`\n✅ Inserted ${inserted} new jobs into queue`);
  log(`🗄 Archived ${archived} low-score jobs`);
  log(`⏭ Skipped ${uniqueJobs.length - inserted - archived} already in database`);
}

main().catch(err => { log(`💥 Fatal: ${err.message}`); process.exit(1); });

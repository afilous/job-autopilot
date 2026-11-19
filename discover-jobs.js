/**
 * Job Autopilot — Search-based Job Discovery
 * Sources: Adzuna + JSearch + SerpApi (+ optional SerpApi site: search)
 * Scores jobs at insert time using the shared engine in lib/scoring.js
 */

const { createClient } = require('@supabase/supabase-js');
const { scoreJob } = require('./lib/scoring');
const { guessAtsType, guessCompanySlug, looksLikeJobUrl } = require('./lib/url-capture');
const { logRun } = require('./lib/runlog');

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
// monthly allowance. Defaults to OFF. Set ENABLE_SITE_SEARCH=true as a
// workflow input only on runs where you deliberately want it.
const ENABLE_SITE_SEARCH = process.env.ENABLE_SITE_SEARCH === 'true';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── URL parsing + "best link" ranking ─────────────────────────────────────────
// Search APIs return several apply links per job (job board, Google, employer
// ATS). Rank them so the employer's own ATS link wins; Tsenta needs that link.
// Job-board / aggregator links are kept only as a last-resort fallback.

const AGGREGATOR_RE = /(linkedin|indeed|ziprecruiter|theladders|jobleads|bebee|builtin|glassdoor|themuse|mediabistro|careerbuilder|monster|talent\.com|jooble|adzuna|learn4good|simplyhired|dice\.com|snagajob|whatjobs|jobrapido|lensa|jobtarget|remotive|weworkremotely|joinrise|cazvid|trueup|wellfound|google\.com|salary\.com|ladders|recruit\.net|jobsora|jobilize|talentify|nexxt|jora|career\.com|efinancialcareers|powertofly|workopolis|swooped|jobgether)/i;

function parseJobUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (!looksLikeJobUrl(url)) return null;
  return {
    ats_type: guessAtsType(url),
    ats_slug: guessCompanySlug(url),
    url: url.split('?')[0],
  };
}

// Pick the best link from a list of candidates:
//   1) a recognized ATS link (Greenhouse, Lever, Ashby, Workday, ...)
//   2) a company-hosted link that is not a known job board
//   3) any job-board link (marked needs-link downstream)
function bestAtsInfo(candidateUrls) {
  const parsed = [];
  const seenUrls = new Set();
  for (const u of candidateUrls) {
    const info = parseJobUrl(u);
    if (info && !seenUrls.has(info.url)) { seenUrls.add(info.url); parsed.push(info); }
  }
  return parsed.find(p => p.ats_type !== 'unknown')
      || parsed.find(p => !AGGREGATOR_RE.test(p.url))
      || parsed[0]
      || null;
}

function isDirectAts(job) { return job.ats_type && job.ats_type !== 'unknown'; }

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


// ── Paid-quota guard ──────────────────────────────────────────────────────────
// JSearch and SerpApi have small monthly free quotas. Their searches look back a
// full week, so they only need to run every other day. By default they run on
// Mon / Thu (UTC weekday numbers 1 and 4). Manual "Run workflow" clicks
// always run. Override with SEARCH_API_DAYS="1,2,3,4,5" to run more often.
function searchApisDueToday() {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true;
  const days = String(process.env.SEARCH_API_DAYS || '1,4').split(',').map(d => parseInt(d, 10));
  return days.includes(new Date().getUTCDay());
}

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
        const descUrls = job.description ? (job.description.match(/https?:\/\/[^\s"'<>]+/g) || []) : [];
        const atsInfo = bestAtsInfo([job.redirect_url, job.adref, job.apply_url, ...descUrls]);
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
  if (!searchApisDueToday()) { log('⏭ JSearch: skipped today (runs Mon/Thu to save quota)'); return []; }
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
        const opts = job.apply_options || [];
        const candidateUrls = [
          ...opts.filter(o => o.is_direct).map(o => o.apply_link),
          job.job_apply_link,
          ...opts.map(o => o.apply_link),
          job.job_google_link, job.job_url,
        ].filter(Boolean);
        const atsInfo = bestAtsInfo(candidateUrls);
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

async function fetchSerpApi() {
  if (!SERPAPI_KEY) { log('⏭ SerpApi: no credentials'); return []; }
  if (!searchApisDueToday()) { log('⏭ SerpApi: skipped today (runs Mon/Thu to save quota)'); return []; }
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
        const atsInfo = bestAtsInfo([...applyLinks, job.share_link, job.related_links?.[0]?.link].filter(Boolean));
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

// ── SerpApi site:-restricted search (GATED — see ENABLE_SITE_SEARCH above) ──

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
    log('⏭ SerpApi site search: disabled (set ENABLE_SITE_SEARCH=true to run)');
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

// ── Same job, many links: dedupe by company + title ───────────────────────────
// The same posting often comes back from several boards. Keep one row per
// company+title, preferring the direct ATS link and then the higher score.

function normCompany(c) {
  return String(c || '').toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\b(inc|llc|corp|corporation|co|ltd|limited|usa|us|holdings)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9&]/g, '');
}
function jobKey(j) { return `${normCompany(j.company)}|${normTitle(j.job_title)}`; }

function dedupeByCompanyTitle(jobs) {
  const best = new Map();
  for (const j of jobs) {
    const k = jobKey(j);
    const cur = best.get(k);
    if (!cur) { best.set(k, j); continue; }
    const better = (isDirectAts(j) && !isDirectAts(cur))
      || (isDirectAts(j) === isDirectAts(cur) && j.match_score > cur.match_score);
    if (better) best.set(k, j);
  }
  return [...best.values()];
}

// Drop jobs whose company+title is already in the database under any link.
async function dropKnownCompanyTitles(jobs) {
  if (jobs.length === 0) return jobs;
  const titles = [...new Set(jobs.map(j => j.job_title).filter(Boolean))];
  const known = new Set();
  const CHUNK = 100;
  for (let i = 0; i < titles.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('applications').select('company, job_title')
      .in('job_title', titles.slice(i, i + CHUNK));
    if (error) { log(`  ⚠ company/title lookup failed: ${error.message}`); return jobs; }
    for (const r of data || []) known.add(jobKey(r));
  }
  const kept = jobs.filter(j => !known.has(jobKey(j)));
  log(`   Dropped ${jobs.length - kept.length} jobs already in the database under another link`);
  return kept;
}

// ── Feed the company list ─────────────────────────────────────────────────────
// Every direct Greenhouse/Lever/Ashby/Workable/SmartRecruiters link we find
// tells us a company's board slug. Save it so discover-jobs-api.js polls that
// company's whole board every day, not just the one posting we happened to see.

const BOARD_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters']);
const BAD_SLUGS = new Set(['jobs', 'job', 'view', 'embed', 'apply', 'j', 'careers', 'career', 'o', 'p', 'www', 'unknown', 'postings', 'en']);

function cap(s) { return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

async function saveDiscoveredCompanies(jobs) {
  const bySlug = new Map();
  for (const j of jobs) {
    if (!BOARD_ATS.has(j.ats_type)) continue;
    if (/jobs\.workable\.com/i.test(j.url || '')) continue; // slug is not in this URL form
    const slug = String(j.ats_slug || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,60}$/.test(slug) || BAD_SLUGS.has(slug)) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, { name: cap(slug), ats_type: j.ats_type, ats_slug: slug, active: true });
  }
  const rows = [...bySlug.values()];
  if (rows.length === 0) return 0;
  const { data, error } = await supabase.from('companies')
    .upsert(rows, { onConflict: 'ats_slug', ignoreDuplicates: true }).select('ats_slug');
  if (error) { log(`  ⚠ Saving discovered companies failed: ${error.message}`); return 0; }
  return (data || []).length;
}

// ── Insert jobs ───────────────────────────────────────────────────────────────
// FIXED (same bug as discover-jobs-api.js): insert() -> upsert(..., { onConflict:
// 'url', ignoreDuplicates: true }), so a single URL collision doesn't fail the
// whole batch. Also removed an invalid `.catch()` chained directly onto a
// Supabase query builder call, which threw "catch is not a function".

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
    const { data, error } = await supabase.from('applications').upsert(
      toQueue.map(j => ({
        job_title: j.job_title, company: j.company, ats_type: j.ats_type,
        ats_slug: j.ats_slug, external_id: j.url, url: j.url,
        location: j.location || '', status: 'queued', match_score: j.match_score, source: j.source,
      })),
      { onConflict: 'url', ignoreDuplicates: true }
    ).select();
    if (error) log(`  ❌ Insert error (queue): ${error.message}`);
    else inserted = (data || []).length;
  }

  let archived = 0;
  if (toArchive.length > 0) {
    const { data, error } = await supabase.from('applications').upsert(
      toArchive.map(j => ({
        job_title: j.job_title, company: j.company, ats_type: j.ats_type,
        ats_slug: j.ats_slug, external_id: j.url, url: j.url,
        location: j.location || '', status: 'archived', match_score: j.match_score, source: j.source,
      })),
      { onConflict: 'url', ignoreDuplicates: true }
    ).select();
    if (error) log(`  ❌ Insert error (archive): ${error.message}`);
    else archived = (data || []).length;
  }

  return { inserted, archived };
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
  const urlUnique = allJobs.filter(j => {
    if (!j.url || seen.has(j.url)) return false;
    seen.add(j.url); return true;
  });

  // Companies first: even a duplicate posting teaches us a new board slug.
  const newCompanies = await saveDiscoveredCompanies(urlUnique);
  log(`🏢 Added ${newCompanies} new companies to the daily board list`);

  const directCount = urlUnique.filter(isDirectAts).length;
  log(`🔗 Links found: ${directCount} direct ATS, ${urlUnique.length - directCount} job-board only`);

  const uniqueJobs = await dropKnownCompanyTitles(dedupeByCompanyTitle(urlUnique));

  log(`\n📊 Scored jobs found: ${uniqueJobs.length}`);
  log(`   Score 90+: ${uniqueJobs.filter(j => j.match_score >= 90).length}`);
  log(`   Score 82-89: ${uniqueJobs.filter(j => j.match_score >= 82 && j.match_score < 90).length}`);
  log(`   Score 75-81: ${uniqueJobs.filter(j => j.match_score >= 75 && j.match_score < 82).length}`);

  const { inserted, archived } = await insertJobs(uniqueJobs);
  log(`\n✅ Inserted ${inserted} new jobs into queue`);
  log(`🗄 Archived ${archived} low-score jobs`);
  log(`⏭ Skipped ${uniqueJobs.length - inserted - archived} already in database`);
  await logRun(supabase, 'discover-jobs', { found: allJobs.length, inserted, archived, notes: `${directCount} direct ATS links, ${newCompanies} new companies` });
}

main().catch(async err => { log(`💥 Fatal: ${err.message}`); await logRun(supabase, 'discover-jobs', { errors: 1, notes: err.message }); process.exit(1); });

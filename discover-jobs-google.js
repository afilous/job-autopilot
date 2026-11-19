/**
 * Job Autopilot — Site-scoped web search discovery
 *
 * Google's Custom Search JSON API now returns 403 for this project (closed to
 * new customers, being retired), so this script no longer uses it. It runs the
 * same idea — "search the ATS job boards for my target titles" — through a
 * search API that works:
 *
 *   Combined (every query goes to both, results merged and de-duplicated):
 *     Tavily      (TAVILY_API_KEY)                      — 1,000 free credits/month
 *     Bright Data (BRIGHTDATA_API_KEY + BRIGHTDATA_ZONE) — 5,000 free/month
 *   Backup (only if both of the above fail):
 *     SerpApi (SERPAPI_KEY) — 250 free/month, shared with discover-jobs.js
 *     Serper  (SERPER_API_KEY) — 2,500 one-time credits, never renew
 *   Budgets are tracked in Supabase (view api_quota_status) and every call stops
 *   before the free limit, so nothing is ever billed.
 *
 * Each query is: (site:board1 OR site:board2 ...) "title" (remote OR Bay Area terms)
 * limited to the past 24 hours by default (SEARCH_WINDOW=d|w|m), so every run mostly returns new postings.
 * Results are scored with lib/scoring.js (same as every other source); the
 * Supabase triggers then assign the fit tier.
 *
 * Env vars:
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *   TAVILY_API_KEY, SERPAPI_KEY, SERPER_API_KEY  (any one or more)
 *   QUERIES_PER_RUN  (optional, default 12)
 *   DRY_RUN=true     (optional: print matches, write nothing)
 */

const { createClient } = require('@supabase/supabase-js');
const { scoreJob } = require('./lib/scoring');
const { guessAtsType, guessCompanySlug, looksLikeJobUrl } = require('./lib/url-capture');
const { logRun } = require('./lib/runlog');
const { createSearcher } = require('./lib/search');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const QUERIES_PER_RUN = parseInt(process.env.QUERIES_PER_RUN || '16', 10);
// Time window for results: d = past 24 hours (default), w = past week, m = past month
const WINDOW = ['d','w','m'].includes(process.env.SEARCH_WINDOW) ? process.env.SEARCH_WINDOW : 'd';
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Where to search ──────────────────────────────────────────────────────────
// Boards Tsenta can apply to directly.
const BOARDS = [
  'jobs.ashbyhq.com',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.lever.co',
  'apply.workable.com',
  'jobs.smartrecruiters.com',
  'jobs.gem.com',
  'jobs.breezy.hr',
];

// Location words that keep results to Bay Area / remote-US postings.
const PLACE_CLAUSE = '(remote OR "San Francisco" OR "Bay Area" OR "San Jose" OR "Palo Alto" OR "Oakland")';

// ── Rotating search terms ────────────────────────────────────────────────────
const SEARCH_TERMS = [
  '"chief of staff"',
  '"head of operations"',
  '"business operations"',
  '"strategy & operations" OR "strategy and operations"',
  '"strategy ops" OR "strategic operations" OR "ops & strategy"',
  '"biz ops" OR "bizops"',
  '"revenue operations" OR "revops"',
  '"GTM operations" OR "go-to-market operations" OR "sales operations"',
  '"partner operations" OR "partnerships operations"',
  '"special projects" OR "founder\'s office" OR "founders associate"',
  '"corporate strategy" OR "strategic planning" OR "business planning"',
  '"program manager" operations',
  '"operations manager"',
  '"business transformation" OR "change management"',
  '"deal desk"',
  '"forward deployed" operations',
];

function pickTermsForToday() {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const dayOfYear = Math.floor((Date.now() - start.getTime()) / 86400000);
  const offset = (dayOfYear * QUERIES_PER_RUN) % SEARCH_TERMS.length;
  const rotated = [...SEARCH_TERMS.slice(offset), ...SEARCH_TERMS.slice(0, offset)];
  return rotated.slice(0, Math.min(QUERIES_PER_RUN, SEARCH_TERMS.length));
}

// ── Search providers (shared layer: lib/search.js) ───────────────────────────

const searcher = createSearcher({ supabase, window: WINDOW, mode: 'merge', log });
const PROVIDER = searcher.providers.join('+') || 'none';

// ── Turn a search hit into a job candidate ───────────────────────────────────

// "Job Application for Chief of Staff at Acme" / "Chief of Staff @ Acme" /
// "Acme - Chief of Staff" / "Chief of Staff - Acme | Greenhouse"
function cleanTitle(raw, company) {
  let t = String(raw || '')
    .replace(/&amp;/g, '&')
    .replace(/^job application for\s+/i, '')
    .replace(/\s*[|·]\s*(greenhouse|lever|ashby|workable|smartrecruiters|breezy.*)$/i, '')
    .trim();
  const m = t.match(/^(.*?)\s+(?:at|@)\s+([^|]+)$/i);
  if (m) t = m[1].trim();
  if (company) {
    const esc = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${esc}\\s*[-–—:|]\\s*`, 'i'), '').replace(new RegExp(`\\s*[-–—:|]\\s*${esc}$`, 'i'), '');
  }
  return t.trim();
}

function companyFromResult(raw, link) {
  const m = String(raw || '').match(/\s(?:at|@)\s+([^|\-–—]+?)(?:\s*[|\-–—].*)?$/i);
  if (m) return m[1].trim();
  const slug = guessCompanySlug(link);
  return slug && slug !== 'unknown'
    ? slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : 'Unknown';
}

function resultToJob(item, searchTerm) {
  const link = item.link || '';
  const company = companyFromResult(item.title, link);
  const title = cleanTitle(item.title, company);
  return {
    job_title: title,
    company,
    ats_type: guessAtsType(link),
    ats_slug: guessCompanySlug(link),
    external_id: link,
    url: link,
    description: item.snippet || '',
    match_score: null,
    source: 'google-search',
    term: searchTerm,
  };
}

// ── Insert ───────────────────────────────────────────────────────────────────
// Dedupe on url (unique) and on (ats_type, external_id). The Supabase triggers
// classify the row; JS only decides queued (>=75) vs archived (1-74) like the
// other discovery scripts, and the DB rescues archived apply/review rows.

async function insertJobs(jobs) {
  if (jobs.length === 0) return { inserted: 0, archived: 0 };

  const urls = jobs.map(j => j.url);
  const known = new Set();
  for (let i = 0; i < urls.length; i += 100) {
    const { data, error } = await supabase.from('applications').select('url').in('url', urls.slice(i, i + 100));
    if (error) { log(`  ⚠ existing-url lookup failed: ${error.message}`); continue; }
    for (const r of data || []) known.add(r.url);
  }
  const fresh = jobs.filter(j => !known.has(j.url));
  log(`   ${jobs.length - fresh.length} already in the database, ${fresh.length} new`);
  if (fresh.length === 0) return { inserted: 0, archived: 0 };

  const toRow = (j, status) => ({
    job_title: j.job_title,
    company: j.company,
    ats_type: j.ats_type,
    ats_slug: j.ats_slug,
    external_id: j.external_id,
    url: j.url,
    location: '',
    status,
    match_score: j.match_score,
    source: j.source,
  });

  const queue = fresh.filter(j => j.match_score >= 75).map(j => toRow(j, 'queued'));
  const archive = fresh.filter(j => j.match_score > 0 && j.match_score < 75).map(j => toRow(j, 'archived'));

  let inserted = 0, archived = 0;
  for (const [rows, kind] of [[queue, 'queue'], [archive, 'archive']]) {
    if (rows.length === 0) continue;
    const { data, error } = await supabase
      .from('applications')
      .upsert(rows, { onConflict: 'url', ignoreDuplicates: true })
      .select('id');
    if (error) { log(`  ❌ Insert error (${kind}): ${error.message}`); continue; }
    if (kind === 'queue') inserted = (data || []).length; else archived = (data || []).length;
  }
  return { inserted, archived };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (searcher.providers.length === 0) {
    const msg = 'No search API key set: add BRIGHTDATA_API_KEY + BRIGHTDATA_ZONE, TAVILY_API_KEY, SERPER_API_KEY or SERPAPI_KEY as a GitHub secret';
    log(`❌ ${msg}`);
    await logRun(supabase, 'discover-jobs-google', { errors: 1, notes: msg });
    throw new Error(msg);
  }

  const terms = pickTermsForToday();
  log(`🚀 Site-scoped search via ${PROVIDER} — ${terms.length} queries${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const all = [];
  let failed = 0;

  for (const term of terms) {
    const results = await searcher.search(`${term} ${PLACE_CLAUSE}`, BOARDS);
    if (results === null) { failed++; await sleep(800); continue; }

    let kept = 0;
    for (const item of results) {
      if (!looksLikeJobUrl(item.link)) continue;
      const job = resultToJob(item, term);
      job.match_score = scoreJob({
        title: job.job_title,
        department: '',
        description: job.description,
        location: job.description,
        company: job.company,
      });
      if (job.match_score > 0) { all.push(job); kept++; }
    }
    log(`  ${term}: ${results.length} result(s), ${kept} relevant`);
    await sleep(800);
  }

  // Fail loudly: a run where every query failed must not look green.
  if (failed === terms.length) {
    const msg = `All ${terms.length} searches failed via ${PROVIDER} (keys wrong, or every free budget used up: see view api_quota_status)`;
    await logRun(supabase, 'discover-jobs-google', { errors: failed, notes: msg });
    throw new Error(msg);
  }
  if (failed > 0) log(`  ⚠ ${failed}/${terms.length} searches failed`);

  const seen = new Set();
  const unique = all.filter(j => (seen.has(j.url) ? false : (seen.add(j.url), true)));
  log(`\n📊 Relevant jobs found: ${unique.length} (${unique.filter(j => j.match_score >= 75).length} score 75+)`);

  if (DRY_RUN) {
    for (const j of unique.slice(0, 60)) log(`   [${j.match_score}] ${j.company} — ${j.job_title} — ${j.url}`);
    return;
  }

  const { inserted, archived } = await insertJobs(unique);
  log(`✅ Queued ${inserted} new jobs, archived ${archived} lower-score jobs`);
  await logRun(supabase, 'discover-jobs-google', {
    found: unique.length, inserted, archived, errors: failed, notes: `providers=${JSON.stringify(searcher.used)} window=${WINDOW}`,
  });
}

main().catch(err => {
  log(`💥 Fatal: ${err.message}`);
  process.exit(1);
});

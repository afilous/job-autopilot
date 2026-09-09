/**
 * Job Autopilot — Google Custom Search Job Discovery
 * Uses the free Custom Search JSON API (100 queries/day) against a
 * Programmable Search Engine scoped to 18 job-board/ATS domains
 * (jobs.ashbyhq.com, boards.greenhouse.io, *.myworkdayjobs.com, etc.)
 *
 * Scores jobs at insert time using the same lib/scoring.js used by
 * discover-jobs-api.js, so Director exclusions, CoS stage-gating, and the
 * Strategic Finance rule all apply identically here.
 *
 * Env vars needed:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   GOOGLE_SEARCH_API_KEY
 *   GOOGLE_SEARCH_ENGINE_ID   (the "cx" value)
 */

const { createClient } = require('@supabase/supabase-js');
const { scoreJob } = require('./lib/scoring');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Rotating search terms ──────────────────────────────────────────────────
const SEARCH_TERMS = [
  '"chief of staff"',
  '"business operations"',
  '"strategy & operations"',
  '"strategy and operations"',
  '"revenue operations"',
  '"business transformation"',
  '"founders associate"',
  '"founder\'s office"',
  '"deal desk"',
  '"GTM operations"',
  '"biz ops"',
  '"special projects"',
  '"corporate strategy"',
  '"strategic operations"',
  '"revenue insights"',
  '"forward deployed operations"',
  '"sales strategy & operations"',
  '"change management"',
  '"business planning"',
  '"strategic planning"',
];

const QUERIES_PER_RUN = 15;

function pickTermsForToday() {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const diff = Date.now() - start.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));

  const rotated = [
    ...SEARCH_TERMS.slice(dayOfYear % SEARCH_TERMS.length),
    ...SEARCH_TERMS.slice(0, dayOfYear % SEARCH_TERMS.length),
  ];
  return rotated.slice(0, QUERIES_PER_RUN);
}

// ── Google Custom Search API call ──────────────────────────────────────────

async function searchGoogle(term) {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', GOOGLE_SEARCH_API_KEY);
  url.searchParams.set('cx', GOOGLE_SEARCH_ENGINE_ID);
  url.searchParams.set('q', term);
  url.searchParams.set('num', '10');

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`  ⚠ Google Search API error for "${term}": ${res.status} ${body.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    return data.items || [];
  } catch (e) {
    log(`  ⚠ Google Search API fetch failed for "${term}": ${e.message}`);
    return [];
  }
}

// ── Parse a search result into a job candidate ─────────────────────────────

function resultToJob(item, searchTerm) {
  const title = item.title || '';
  const snippet = item.snippet || '';
  const link = item.link || '';

  let company = 'Unknown';
  try {
    const u = new URL(link);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      company = parts[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
  } catch (e) { /* leave as Unknown */ }

  return {
    job_title: title,
    company,
    ats_type: 'google-search',
    ats_slug: null,
    external_id: link,
    url: link,
    location: snippet,
    description: snippet,
    match_score: null,
    source: `google-search:${searchTerm}`,
  };
}

// ── Insert jobs ───────────────────────────────────────────────────────────────
// FIXED: onConflict was set to 'url', but the table's real unique
// constraint, applications_ats_external_unique, is enforced on
// (ats_type, external_id) -- NOT on url. This mismatch meant Postgres
// couldn't resolve conflicts via ON CONFLICT and threw a hard duplicate-key
// error, failing the entire batch instead of skipping individual repeat
// rows. Same root cause and fix as discover-jobs-api.js.

async function insertJobs(jobs) {
  if (jobs.length === 0) return { inserted: 0, archived: 0 };

  const externalIds = jobs.map(j => j.external_id).filter(Boolean);
  const { data: existing } = await supabase
    .from('applications')
    .select('external_id')
    .in('external_id', externalIds);

  const existingIds = new Set((existing || []).map(e => e.external_id));
  const newJobs = jobs.filter(j => j.external_id && !existingIds.has(j.external_id));

  if (newJobs.length === 0) return { inserted: 0, archived: 0 };

  const toQueue = newJobs.filter(j => j.match_score >= 75);
  const toArchive = newJobs.filter(j => j.match_score > 0 && j.match_score < 75);

  let inserted = 0;
  if (toQueue.length > 0) {
    const { data, error } = await supabase.from('applications').upsert(
      toQueue.map(j => ({
        job_title: j.job_title,
        company: j.company,
        ats_type: j.ats_type,
        ats_slug: j.ats_slug,
        external_id: j.external_id,
        url: j.url,
        location: '',
        status: 'queued',
        match_score: j.match_score,
        source: j.source,
      })),
      { onConflict: 'ats_type,external_id', ignoreDuplicates: true }
    ).select();
    if (error) log(`  ❌ Insert error (queue): ${error.message}`);
    else inserted = (data || []).length;
  }

  let archived = 0;
  if (toArchive.length > 0) {
    const { data, error } = await supabase.from('applications').upsert(
      toArchive.map(j => ({
        job_title: j.job_title,
        company: j.company,
        ats_type: j.ats_type,
        ats_slug: j.ats_slug,
        external_id: j.external_id,
        url: j.url,
        location: '',
        status: 'archived',
        match_score: j.match_score,
        source: j.source,
      })),
      { onConflict: 'ats_type,external_id', ignoreDuplicates: true }
    ).select();
    if (error) log(`  ❌ Insert error (archive): ${error.message}`);
    else archived = (data || []).length;
  }

  return { inserted, archived };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_ENGINE_ID) {
    log('⚠ GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_ENGINE_ID not set — skipping');
    return;
  }

  const terms = pickTermsForToday();
  log(`🚀 Starting Google Custom Search discovery — ${terms.length} terms today`);
  log(`   Terms: ${terms.join(', ')}`);

  let allJobs = [];

  for (const term of terms) {
    const results = await searchGoogle(term);
    log(`  "${term}": ${results.length} result(s)`);

    for (const item of results) {
      const job = resultToJob(item, term);
      job.match_score = scoreJob({
        title: job.job_title,
        department: '',
        description: job.description,
        location: job.location,
        company: job.company,
      });
      if (job.match_score > 0) allJobs.push(job);
    }

    await sleep(500);
  }

  const seen = new Set();
  const uniqueJobs = allJobs.filter(j => {
    if (!j.external_id || seen.has(j.external_id)) return false;
    seen.add(j.external_id);
    return true;
  });

  log(`\n📊 Scored jobs found: ${uniqueJobs.length} (score > 0)`);
  log(`   Total queued (75+): ${uniqueJobs.filter(j => j.match_score >= 75).length}`);

  const { inserted, archived } = await insertJobs(uniqueJobs);
  log(`\n✅ Inserted ${inserted} new jobs into queue`);
  log(`🗄 Archived ${archived} low-score jobs`);
}

main().catch(err => {
  log(`💥 Fatal: ${err.message}`);
  process.exit(1);
});

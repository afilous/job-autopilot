/**
 * Job Autopilot — Greenhouse API Discovery
 * Uses the free public Greenhouse Job Board API to fetch jobs from known companies
 * No API key required for GET endpoints
 * Run: node discover-jobs-api.js
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Keywords to filter relevant jobs ─────────────────────────────────────────
const TITLE_KEYWORDS = [
  'strategy', 'operations', 'ops', 'chief of staff', 'bizops', 'biz ops',
  'gtm', 'go-to-market', 'revenue operations', 'revops', 'program manager',
  'business operations', 'strategic', 'growth', 'planning',
];

const LOCATION_KEYWORDS = [
  'san francisco', 'sf', 'bay area', 'remote', 'san mateo',
  'oakland', 'palo alto', 'mountain view', 'sunnyvale', 'santa clara',
  'united states', 'us', 'usa', '',
];

function isRelevantTitle(title) {
  const t = title.toLowerCase();
  return TITLE_KEYWORDS.some(k => t.includes(k));
}

function isRelevantLocation(location) {
  if (!location) return true; // no location = possibly remote
  const l = location.toLowerCase();
  return LOCATION_KEYWORDS.some(k => l.includes(k));
}

// ── Greenhouse companies to check ─────────────────────────────────────────────
const GREENHOUSE_SLUGS = [
  'airbnb', 'lyft', 'doordash', 'instacart', 'openai', 'anthropic',
  'stripe', 'notion', 'figma', 'intercom', 'verkada', 'rippling',
  'brex', 'amplitude', 'lattice', 'mixpanel', 'airtable', 'asana',
  'zendesk', 'gusto', 'faire', 'confluent', 'databricks', 'benchling',
  'ironclad', 'gainsight', 'robinhood', 'chime', 'affirm', 'mercury',
  'deel', 'anduril', 'palantir', 'flexport', 'front', 'whatnot',
  'addepar', 'decagon', 'sierra', 'zip', 'miro', 'navan', 'loom',
  'dropbox', 'cohesity', 'zillow', 'adobe', 'docusign', 'darktrace',
  'ebay', 'capitalone', 'snorkelai', 'cohere', 'glean', 'harvey',
  'replit', 'coda', 'persona', 'checkr', 'plaid', 'carta', 'gem',
  'gong', 'outreach', 'salesloft', 'seismic', 'highspot', 'clari',
  'klarna', 'marqeta', 'samsara', 'talkdesk', 'klaviyo', 'iterable',
  'braze', 'fivetran', 'airbyte', 'thoughtspot', 'montecarlodata',
  'lacework', 'orca', 'wiz', 'snyk', 'rubrik', 'zscaler', 'okta',
  'betterup', 'springhealth', 'lyrahealth', 'hingehealth', 'veeva',
  'uipath', 'celonis', 'clickup', 'mondaycom', 'smartsheet', 'calendly',
  'chilipiper', 'freshworks', 'kustomer', 'gladly', 'pinterest',
  'realtimeboardglobal', 'retool', 'lob', 'scale', 'scaleai',
];

// ── Ashby companies ───────────────────────────────────────────────────────────
const ASHBY_SLUGS = [
  'ramp', 'linear', 'airwallex', 'vercel', 'descript', 'watershed',
  'hightouch', 'metabase', 'posthog', 'hex', 'census', 'webflow',
  'pave', 'remote', 'leapsome', 'hibob', 'superblockshq', 'equals',
  'baseten', 'modal', 'replicate', 'togetherai', 'groq', 'cerebras',
  'poolside', 'cognition', 'contextualai', 'elevenlabs', 'synthesia',
  'lumaai', 'tome', 'gamma', 'mercor', 'karat', 'dover', 'comulate',
  'finvest', 'JoinForage', 'sierra',
];

// ── Lever companies ───────────────────────────────────────────────────────────
const LEVER_SLUGS = [
  'plaid', 'rover', 'canarytechnologies', 'filevine', 'udemy',
  'coursera', 'duolingo', 'handshake', 'olo', 'lime', 'walkme',
  'matchgroup', 'encord', 'curri', 'owner', 'shieldai', 'evrealty-us',
  'anchorage', 'sprypointservices', 'cfgi',
];

// ── Fetch Greenhouse jobs for a slug ─────────────────────────────────────────
async function fetchGreenhouseJobs(slug) {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];

    const data = await res.json();
    const jobs = data.jobs || [];

    return jobs
      .filter(j => isRelevantTitle(j.title) && isRelevantLocation(j.location?.name))
      .map(j => ({
        job_title: j.title,
        company: slug.charAt(0).toUpperCase() + slug.slice(1),
        ats_type: 'greenhouse',
        ats_slug: slug,
        external_id: String(j.id),
        url: j.absolute_url,
        location: j.location?.name || '',
        source: 'greenhouse-api',
      }));
  } catch (e) {
    return [];
  }
}

// ── Fetch Ashby jobs for a slug ───────────────────────────────────────────────
async function fetchAshbyJobs(slug) {
  try {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];

    const data = await res.json();
    const jobs = data.jobPostings || [];

    return jobs
      .filter(j => isRelevantTitle(j.title) && isRelevantLocation(j.locationName || j.location))
      .map(j => ({
        job_title: j.title,
        company: data.organization?.name || slug.charAt(0).toUpperCase() + slug.slice(1),
        ats_type: 'ashby',
        ats_slug: slug,
        external_id: j.id,
        url: `https://jobs.ashbyhq.com/${slug}/${j.id}`,
        location: j.locationName || j.location || '',
        source: 'ashby-api',
      }));
  } catch (e) {
    return [];
  }
}

// ── Fetch Lever jobs for a slug ───────────────────────────────────────────────
async function fetchLeverJobs(slug) {
  try {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json&limit=250`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];

    const jobs = await res.json();
    if (!Array.isArray(jobs)) return [];

    return jobs
      .filter(j => isRelevantTitle(j.text) && isRelevantLocation(j.categories?.location))
      .map(j => ({
        job_title: j.text,
        company: j.company || slug.charAt(0).toUpperCase() + slug.slice(1),
        ats_type: 'lever',
        ats_slug: slug,
        external_id: j.id,
        url: j.hostedUrl,
        location: j.categories?.location || '',
        source: 'lever-api',
      }));
  } catch (e) {
    return [];
  }
}

// ── Insert jobs into Supabase ─────────────────────────────────────────────────
async function insertJobs(jobs) {
  if (jobs.length === 0) return 0;

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
      match_score: 0,
      source: j.source,
    }))
  );

  if (error) { log(`  ❌ Insert error: ${error.message}`); return 0; }
  return newJobs.length;
}

// ── Process slugs in parallel batches ────────────────────────────────────────
async function processBatch(slugs, fetchFn, label) {
  const CONCURRENCY = 10;
  const allJobs = [];
  let processed = 0;

  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(slug => fetchFn(slug)));
    for (const jobs of results) allJobs.push(...jobs);
    processed += batch.length;
    process.stdout.write(`\r  ${label}: ${processed}/${slugs.length} checked, ${allJobs.length} jobs found`);
    await sleep(300);
  }
  console.log('');
  return allJobs;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('🚀 Starting API-based job discovery...');
  log(`   Greenhouse: ${GREENHOUSE_SLUGS.length} companies`);
  log(`   Ashby:      ${ASHBY_SLUGS.length} companies`);
  log(`   Lever:      ${LEVER_SLUGS.length} companies`);

  const ghJobs = await processBatch(GREENHOUSE_SLUGS, fetchGreenhouseJobs, 'Greenhouse');
  const abJobs = await processBatch(ASHBY_SLUGS, fetchAshbyJobs, 'Ashby');
  const lvJobs = await processBatch(LEVER_SLUGS, fetchLeverJobs, 'Lever');

  const allJobs = [...ghJobs, ...abJobs, ...lvJobs];

  // Deduplicate by external_id
  const seen = new Set();
  const uniqueJobs = allJobs.filter(j => {
    if (!j.external_id || seen.has(j.external_id)) return false;
    seen.add(j.external_id);
    return true;
  });

  log(`\n📊 Relevant jobs found:`);
  log(`   Greenhouse: ${ghJobs.length}`);
  log(`   Ashby:      ${abJobs.length}`);
  log(`   Lever:      ${lvJobs.length}`);
  log(`   Total:      ${uniqueJobs.length}`);

  const inserted = await insertJobs(uniqueJobs);
  log(`\n✅ Inserted ${inserted} new jobs`);
  log(`⏭ Skipped ${uniqueJobs.length - inserted} already in database`);
}

main().catch(err => {
  log(`💥 Fatal: ${err.message}`);
  process.exit(1);
});

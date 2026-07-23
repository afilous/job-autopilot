/**
 * Job Autopilot — API-based Job Discovery
 * Scores jobs at insert time — bad jobs never enter the queue
 */

const { createClient } = require('@supabase/supabase-js');
const { scoreJob } = require('./lib/scoring');
const { SMARTRECRUITERS_SLUGS, fetchSmartRecruitersJobs, WORKABLE_SLUGS, fetchWorkableJobs } = require('./new-ats-fetchers');
const { fetchAllWorkdayJobs } = require('./workday-fetcher');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Greenhouse companies (hardcoded floor) ────────────────────────────────────
const GREENHOUSE_SLUGS = [
  'airbnb', 'lyft', 'doordash', 'instacart', 'openai', 'anthropic',
  'stripe', 'notion', 'figma', 'intercom', 'verkada', 'rippling',
  'brex', 'amplitude', 'lattice', 'mixpanel', 'airtable', 'asana',
  'zendesk', 'gusto', 'faire', 'confluent', 'databricks', 'benchling',
  'ironclad', 'gainsight', 'robinhood', 'chime', 'affirm', 'mercury',
  'deel', 'anduril', 'flexport', 'front', 'whatnot', 'addepar',
  'decagon', 'sierra', 'zip', 'miro', 'navan', 'loom', 'dropbox',
  'cohesity', 'zillow', 'adobe', 'docusign', 'ebay', 'snorkelai',
  'cohere', 'glean', 'harvey', 'replit', 'coda', 'persona', 'checkr',
  'plaid', 'carta', 'gem', 'gong', 'outreach', 'salesloft', 'seismic',
  'highspot', 'clari', 'klarna', 'marqeta', 'samsara', 'talkdesk',
  'klaviyo', 'iterable', 'braze', 'fivetran', 'airbyte', 'thoughtspot',
  'lacework', 'orca', 'wiz', 'snyk', 'rubrik', 'zscaler', 'okta',
  'betterup', 'springhealth', 'lyrahealth', 'hingehealth', 'veeva',
  'uipath', 'celonis', 'clickup', 'smartsheet', 'calendly', 'chilipiper',
  'freshworks', 'kustomer', 'gladly', 'pinterest', 'retool', 'lob',
  'scaleai', 'scale', 'workato', 'medallia', 'sprinklr', 'contentful',
  'aurora', 'waymo', 'cruise', 'nuro', 'zoox', 'motional',
  'coinbase', 'kraken', 'gemini', 'anchorage',
  'palantir', 'anduril', 'shieldai',
  'flexport', 'shipbob', 'project44',
  'toast', 'servicenow', 'workday', 'veeva',
  'benchling', 'recursion', 'tempus', 'flatiron',
  'devoted', 'cityblock', 'oscar', 'nomi',
  'duolingo', 'coursera', 'handshake', 'canvas',
  'faire', 'faire-wholesale', 'ramp',
  'navan', 'tripactions', 'spotnana',
  'pendo', 'gainsight', 'amplitude', 'mixpanel',
  'figma', 'miro', 'lucid', 'canva',
  'linear', 'notion', 'coda', 'airtable',
  'segment', 'rudderstack', 'hightouch',
  'dbt', 'fivetran', 'airbyte', 'stitch',
];

// ── Ashby companies (hardcoded floor) ─────────────────────────────────────────
const ASHBY_SLUGS = [
  'ramp', 'linear', 'airwallex', 'vercel', 'descript', 'watershed',
  'hightouch', 'metabase', 'posthog', 'hex', 'census', 'webflow',
  'pave', 'remote', 'leapsome', 'hibob', 'superblockshq', 'equals',
  'baseten', 'modal', 'replicate', 'togetherai', 'groq', 'cerebras',
  'poolside', 'cognition', 'contextualai', 'elevenlabs', 'synthesia',
  'lumaai', 'tome', 'gamma', 'mercor', 'karat', 'dover', 'comulate',
  'finvest', 'joinforage', 'sierra', 'primeintellect', 'harvey',
  'rime', 'cursor', 'perplexity', 'mistral', 'cohere', 'adept',
  'observeinc', 'incident', 'rootly', 'firehydrant',
  'assembled', 'maven', 'instabase', 'ironclad',
  'persona', 'unit21', 'sardine', 'alloy',
  'runway', 'synthesia', 'heygen', 'captions',
  'retool', 'airplane', 'appsmith', 'tooljet',
  'clerk', 'neon', 'planetscale', 'turso',
  'resend', 'loops', 'customer-io',
  'june', 'koala', 'warmly', 'common-room',
  'luma', 'partiful', 'offtheleft',
  'watershed', 'terrawatch', 'pachama', 'rubicon',
  'rho', 'brex', 'mercury', 'relay',
  'check', 'rippling', 'deel', 'remote',
  'ashbyhq', 'greenhouse', 'lever', 'workable',
];

// ── Lever companies (hardcoded floor) ─────────────────────────────────────────
const LEVER_SLUGS = [
  'plaid', 'rover', 'canarytechnologies', 'filevine', 'udemy',
  'coursera', 'duolingo', 'handshake', 'olo', 'lime', 'walkme',
  'matchgroup', 'encord', 'curri', 'owner', 'evrealty-us',
  'sprypointservices', 'cfgi', 'anaplan', 'medallia', 'sprinklr',
  'contentful', 'netlify', 'vercel', 'cloudflare',
  'hashicorp', 'confluent', 'mongodb', 'elastic',
  'datadog', 'newrelic', 'splunk', 'dynatrace',
  'pagerduty', 'opsgenie', 'victorops',
  'sendgrid', 'mailchimp', 'klaviyo',
  'hootsuite', 'buffer', 'sprout',
  'zendesk', 'intercom', 'freshdesk', 'kustomer',
  'hubspot', 'marketo', 'pardot',
  'outreach', 'salesloft', 'apollo', 'zoominfo',
  'gong', 'chorus', 'wingman', 'clari',
  'docusign', 'pandadoc', 'ironclad',
  'coupa', 'procurify', 'zip',
  'braintree', 'adyen', 'stripe', 'square',
  'robinhood', 'webull', 'public',
  'chime', 'current', 'varo', 'dave',
  'affirm', 'klarna', 'afterpay', 'sezzle',
  'lemonade', 'root', 'hippo', 'branch',
  'devoted', 'oscar', 'bright-health',
  'hims', 'ro', 'cerebral', 'done',
  'noom', 'calm', 'headspace', 'woebot',
  'peloton', 'mirror', 'tonal', 'hydrow',
  'doorpass', 'gopuff', 'getir', 'jokr',
  'faire', 'handshake', 'lattice', 'culture-amp',
  'leapsome', 'betterworks', '15five', 'reflektive',
];

// ── Fetch with content for ambiguous titles ───────────────────────────────────

async function fetchGreenhouseJobWithContent(slug, jobId) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.content || '';
  } catch(e) { return ''; }
}

// ── ATS fetchers ──────────────────────────────────────────────────────────────

async function fetchGreenhouseJobs(slug) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const jobs = data.jobs || [];
    const results = [];

    for (const j of jobs) {
      const title = j.title || '';
      const location = j.location?.name || '';
      const department = j.departments?.[0]?.name || '';

      let score = scoreJob({ title, department, description: '', location, company: slug });

      if (score === 78 || score === 82) {
        const needsContent = title.toLowerCase().includes('program manager') ||
          title.toLowerCase().includes('operations manager') ||
          title.toLowerCase() === 'operations lead';
        if (needsContent) {
          const content = await fetchGreenhouseJobWithContent(slug, j.id);
          score = scoreJob({ title, department, description: content, location, company: slug });
          await sleep(200);
        }
      }

      if (score > 0) {
        results.push({
          job_title: title,
          company: slug.charAt(0).toUpperCase() + slug.slice(1),
          ats_type: 'greenhouse',
          ats_slug: slug,
          external_id: String(j.id),
          url: j.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${j.id}`,
          location,
          match_score: score,
          source: 'greenhouse-api',
        });
      }
    }
    return results;
  } catch(e) { return []; }
}

async function fetchAshbyJobs(slug) {
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, {
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();

    let jobs = [];
    if (Array.isArray(data)) jobs = data;
    else if (data && typeof data === 'object') {
      jobs = data.results || data.jobs || data.jobPostings || data.postings || [];
    }
    if (!Array.isArray(jobs)) return [];

    return jobs
      .map(j => {
        const title = j.title || '';
        const location = j.locationName || j.location?.name || j.location || '';
        const department = j.departmentName || j.department || '';
        const description = j.descriptionPlain || j.description || '';
        const score = scoreJob({ title, department, description, location, company: slug });
        if (score === 0) return null;
        return {
          job_title: title,
          company: data.organization?.name || slug.charAt(0).toUpperCase() + slug.slice(1),
          ats_type: 'ashby',
          ats_slug: slug,
          external_id: j.id,
          url: j.jobUrl || j.applyLink || `https://jobs.ashbyhq.com/${slug}/${j.id}`,
          location,
          match_score: score,
          source: 'ashby-api',
        };
      })
      .filter(Boolean);
  } catch(e) { return []; }
}

async function fetchLeverJobs(slug) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=250`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const jobs = await res.json();
    if (!Array.isArray(jobs)) return [];

    return jobs
      .map(j => {
        const title = j.text || '';
        const location = j.categories?.location || j.workplaceType || '';
        const department = j.categories?.department || '';
        const description = [
          j.description || '',
          ...(j.lists || []).map(l => l.content || ''),
          j.additional || '',
        ].join(' ');
        const score = scoreJob({ title, department, description, location, company: slug });
        if (score === 0) return null;
        return {
          job_title: title,
          company: j.company || slug.charAt(0).toUpperCase() + slug.slice(1),
          ats_type: 'lever',
          ats_slug: slug,
          external_id: j.id,
          url: j.hostedUrl,
          location,
          match_score: score,
          source: 'lever-api',
        };
      })
      .filter(Boolean);
  } catch(e) { return []; }
}

// ── YC company discovery ──────────────────────────────────────────────────────

async function fetchYCCompanies() {
  try {
    const res = await fetch('https://45bwzj1sgc-dsn.algolia.net/1/indexes/*/queries', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'x-algolia-application-id': '45BWZJ1SGC',
        'x-algolia-api-key': 'Zjk5ZmU5OTc4Njc4MGE4MGZlOThjYTM2YTAyYmNhOWFkNWI5MDIxZjczMjM1YWZjNzU4NjA4YTcyYmNlNjQ2NHRhZ0ZpbHRlcnM9JnJlc3RyaWN0SW5kaWNlcz15Y19jb21wYW5pZXM',
      },
      body: JSON.stringify({
        requests: [{
          indexName: 'yc_companies',
          params: 'hitsPerPage=1000&filters=batch%3AW25%20OR%20batch%3AS24%20OR%20batch%3AW24%20OR%20batch%3AS23',
        }]
      }),
    });
    if (!res.ok) return { greenhouse: [], ashby: [], lever: [] };
    const data = await res.json();
    const companies = data.results?.[0]?.hits || [];
    const slugs = { greenhouse: [], ashby: [], lever: [] };
    for (const c of companies) {
      const url = c.jobsUrl || c.url || c.website || '';
      if (url.includes('greenhouse.io')) { const m = url.match(/greenhouse\.io\/([^/?]+)/); if (m) slugs.greenhouse.push(m[1].toLowerCase()); }
      else if (url.includes('ashbyhq.com')) { const m = url.match(/ashbyhq\.com\/([^/?]+)/); if (m) slugs.ashby.push(m[1].toLowerCase()); }
      else if (url.includes('lever.co')) { const m = url.match(/lever\.co\/([^/?]+)/); if (m) slugs.lever.push(m[1].toLowerCase()); }
    }
    log(`  YC: ${slugs.greenhouse.length} GH, ${slugs.ashby.length} Ashby, ${slugs.lever.length} Lever`);
    return slugs;
  } catch(e) { return { greenhouse: [], ashby: [], lever: [] }; }
}

// ── Pull companies (and Workday tenants) discover-companies.js has found ─────

async function fetchCompaniesFromSupabase(atsType) {
  const PAGE_SIZE = 1000;
  let allSlugs = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('companies')
      .select('ats_slug')
      .eq('ats_type', atsType)
      .eq('active', true)
      .range(from, from + PAGE_SIZE - 1);

    if (error) { log(`  ⚠ Supabase fetch error (${atsType}): ${error.message}`); break; }
    if (!data || data.length === 0) break;

    allSlugs.push(...data.map(row => row.ats_slug));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return allSlugs;
}

async function fetchWorkdayTenantsFromSupabase() {
  const PAGE_SIZE = 1000;
  let allTenants = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('workday_tenants')
      .select('company, tenant, wd_server, site')
      .eq('active', true)
      .range(from, from + PAGE_SIZE - 1);

    if (error) { log(`  ⚠ Supabase fetch error (workday_tenants): ${error.message}`); break; }
    if (!data || data.length === 0) break;

    allTenants.push(...data.map(row => ({
      company: row.company, tenant: row.tenant, wdServer: row.wd_server, site: row.site,
    })));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return allTenants;
}

// ── Insert jobs ───────────────────────────────────────────────────────────────
// FIXED: switched insert() -> upsert(..., { onConflict: 'url', ignoreDuplicates: true }).
// Root cause of the crash this was fixing: applications.url now has a unique
// constraint, but insert() fails the ENTIRE batch if even one row collides --
// Postgres doesn't skip just the bad row. upsert+ignoreDuplicates skips
// colliding rows gracefully instead, same pattern insertCompanies() already
// uses successfully in discover-companies.js.
// ALSO FIXED: removed a `.catch(() => {})` chained directly onto a Supabase
// query builder call -- this throws "catch is not a function" because
// Supabase's builder isn't a real Promise until awaited. Destructure
// { error } and check it instead, per the documented project gotcha.

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
        location: j.location || '',
        status: 'queued',
        match_score: j.match_score,
        source: j.source,
      })),
      { onConflict: 'url', ignoreDuplicates: true }
    ).select();
    if (error) log(`  ❌ Insert error (queue): ${error.message}`);
    else inserted = (data || []).length; // ignoreDuplicates means skipped rows aren't returned/counted
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
        location: j.location || '',
        status: 'archived',
        match_score: j.match_score,
        source: j.source,
      })),
      { onConflict: 'url', ignoreDuplicates: true }
    ).select();
    if (error) log(`  ❌ Insert error (archive): ${error.message}`);
    else archived = (data || []).length;
  }

  return { inserted, archived };
}

// ── Process slugs in parallel batches ────────────────────────────────────────

async function processBatch(slugs, fetchFn, label, batchDelay = 300) {
  const CONCURRENCY = 10;
  const allJobs = [];
  let processed = 0;

  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(slug => fetchFn(slug)));
    for (const jobs of results) allJobs.push(...jobs);
    processed += batch.length;
    process.stdout.write(`\r  ${label}: ${processed}/${slugs.length} checked, ${allJobs.length} jobs found`);
    await sleep(batchDelay);
  }
  console.log('');
  return allJobs;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('🚀 Starting API-based job discovery with inline scoring...');

  log('🔍 Fetching YC company job boards...');
  const ycSlugs = await fetchYCCompanies();

  log('🔍 Fetching discovered companies from Supabase (populated by discover-companies.js)...');
  const [dbGH, dbAB, dbLV, dbSR, dbWK, dbWorkdayTenants] = await Promise.all([
    fetchCompaniesFromSupabase('greenhouse'),
    fetchCompaniesFromSupabase('ashby'),
    fetchCompaniesFromSupabase('lever'),
    fetchCompaniesFromSupabase('smartrecruiters'),
    fetchCompaniesFromSupabase('workable'),
    fetchWorkdayTenantsFromSupabase(),
  ]);
  log(`  📋 Supabase: ${dbGH.length} GH, ${dbAB.length} Ashby, ${dbLV.length} Lever, ` +
      `${dbSR.length} SmartRecruiters, ${dbWK.length} Workable, ${dbWorkdayTenants.length} Workday tenants`);

  const allGHSlugs = [...new Set([...GREENHOUSE_SLUGS, ...ycSlugs.greenhouse, ...dbGH])];
  const allABSlugs = [...new Set([...ASHBY_SLUGS, ...ycSlugs.ashby, ...dbAB])];
  const allLVSlugs = [...new Set([...LEVER_SLUGS, ...ycSlugs.lever, ...dbLV])];
  const allSRSlugs = [...new Set([...SMARTRECRUITERS_SLUGS, ...dbSR])];
  const allWKSlugs = [...new Set([...WORKABLE_SLUGS, ...dbWK])];

  log(`📋 Total to check: ${allGHSlugs.length} GH, ${allABSlugs.length} Ashby, ${allLVSlugs.length} Lever, ` +
      `${allSRSlugs.length} SmartRecruiters, ${allWKSlugs.length} Workable`);

  const ghJobs = await processBatch(allGHSlugs, fetchGreenhouseJobs, 'Greenhouse');
  const abJobs = await processBatch(allABSlugs, fetchAshbyJobs, 'Ashby', 1200);
  const lvJobs = await processBatch(allLVSlugs, fetchLeverJobs, 'Lever', 1000);
  const srJobs = await processBatch(allSRSlugs, slug => fetchSmartRecruitersJobs(slug, scoreJob), 'SmartRecruiters', 500);
  const wkJobs = await processBatch(allWKSlugs, slug => fetchWorkableJobs(slug, scoreJob), 'Workable', 500);

  log('🔍 Workday tenants...');
  const wdJobs = await fetchAllWorkdayJobs(scoreJob, dbWorkdayTenants);

  const allJobs = [...ghJobs, ...abJobs, ...lvJobs, ...srJobs, ...wkJobs, ...wdJobs];

  const seen = new Set();
  const uniqueJobs = allJobs.filter(j => {
    if (!j.external_id || seen.has(j.external_id)) return false;
    seen.add(j.external_id);
    return true;
  });

  log(`\n📊 Scored jobs found:`);
  log(`   Score 90+ (exact/CoS/HoO): ${uniqueJobs.filter(j => j.match_score >= 90).length}`);
  log(`   Score 82-89:                ${uniqueJobs.filter(j => j.match_score >= 82 && j.match_score < 90).length}`);
  log(`   Score 78-81 (ambiguous):    ${uniqueJobs.filter(j => j.match_score >= 78 && j.match_score < 82).length}`);
  log(`   Total queued (75+):         ${uniqueJobs.filter(j => j.match_score >= 75).length}`);

  const { inserted, archived } = await insertJobs(uniqueJobs);
  log(`\n✅ Inserted ${inserted} new jobs into queue`);
  log(`🗄 Archived ${archived} low-score jobs`);
  log(`⏭ Skipped ${uniqueJobs.length - inserted - archived} already in database`);
}

main().catch(err => {
  log(`💥 Fatal: ${err.message}`);
  process.exit(1);
});

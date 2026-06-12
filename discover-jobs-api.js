/**
 * Job Autopilot — API-based Job Discovery
 * Scores jobs at insert time — bad jobs never enter the queue
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Scoring constants ─────────────────────────────────────────────────────────

// Titles that are an exact target — score 90 immediately
const TITLE_EXACT_TARGETS = [
  'strategy & operations', 'strategy and operations', 'strategic operations',
  'business operations', 'biz ops', 'bizops', 'biz-ops', 'business ops',
  'revenue operations', 'revops', 'rev ops',
  'gtm operations', 'gtm ops', 'gtm strategy', 'go-to-market operations',
  'sales operations', 'sales ops', 'sales strategy and operations',
  'sales strategy & operations', 'commercial operations',
  'chief of staff', 'special projects', 'strategic initiatives',
  'head of operations', 'head of ops', 'strategic planning',
  'growth operations', 'growth ops', 'growth strategy',
  'corporate strategy', 'business strategy',
];

// Titles that score 82 with a qualifying context word
const TITLE_STRONG_PAIRS = [
  ['operations', ['strategy', 'business', 'revenue', 'sales', 'gtm', 'growth', 'commercial', 'central', 'general']],
  ['strategy', ['operations', 'business', 'growth', 'corporate', 'commercial', 'revenue', 'sales', 'gtm']],
  ['program manager', ['operations', 'strategy', 'ops', 'sales', 'gtm', 'revenue', 'business', 'growth', 'transformation', 'strategic', 'product operations', 'commercial']],
  ['program director', ['operations', 'strategy', 'ops', 'sales', 'gtm', 'revenue', 'business']],
];

// Department names that indicate a real ops/strategy role
const GOOD_DEPARTMENTS = [
  'strategy', 'operations', 'business operations', 'revenue operations',
  'sales operations', 'gtm', 'go-to-market', 'growth', 'finance',
  'strategic finance', 'chief of staff', 'special projects',
  'business development', 'commercial', 'revenue',
];

// Department names that disqualify
const BAD_DEPARTMENTS = [
  'engineering', 'software', 'product', 'design', 'data science',
  'machine learning', 'infrastructure', 'security', 'legal', 'hr',
  'human resources', 'recruiting', 'talent', 'marketing', 'it ',
  'information technology', 'clinical', 'medical', 'nursing',
  'facilities', 'supply chain', 'logistics', 'manufacturing',
];

// Title words that immediately disqualify regardless of other signals
const TITLE_DISQUALIFIERS = [
  'software engineer', 'software developer', 'frontend', 'backend', 'full stack',
  'devops', 'dev ops', 'data engineer', 'data scientist', 'ml engineer',
  'ai engineer', 'machine learning', 'infrastructure engineer', 'platform engineer',
  'solutions engineer', 'sales engineer', 'security engineer',
  'store operations', 'retail operations', 'field operations', 'clinical operations',
  'warehouse operations', 'manufacturing operations', 'plant operations',
  'restaurant operations', 'hotel operations', 'fleet operations',
  'facilities operations', 'distribution operations', 'supply chain operations',
  'it operations', 'security operations', 'noc ', 'help desk',
  'account executive', 'account manager', 'sales representative', 'sales rep',
  'bdr ', 'sdr ', 'inside sales', 'outside sales',
  'product manager', 'product designer', 'ux ', 'ui ',
  'data analyst', 'financial analyst', 'accountant', 'controller',
  'legal counsel', 'attorney', 'paralegal',
  'recruiter', 'talent acquisition', 'hr business partner',
  'content writer', 'copywriter', 'graphic designer',
  'vp ', 'vice president', 'svp', 'evp', 'chief ', 'coo', 'ceo', 'cfo', 'cto',
];

// Description keywords that suggest a good ops/strategy role
const GOOD_DESCRIPTION_SIGNALS = [
  'cross-functional', 'stakeholder', 'p&l', 'okr', 'kpi', 'gtm',
  'go-to-market', 'revenue operations', 'sales operations', 'business operations',
  'strategy', 'operational excellence', 'process improvement', 'sql',
  'data-driven', 'analytics', 'reporting', 'roadmap', 'prioritization',
  'chief of staff', 'special projects', 'scaled', 'hypergrowth',
  'cross functional', 'program management', 'project management',
  'business intelligence', 'tableau', 'salesforce', 'hubspot',
  'annual planning', 'quarterly planning', 'headcount', 'budget',
];

// Description keywords that suggest a bad fit
const BAD_DESCRIPTION_SIGNALS = [
  'plc', 'cnc', 'forklift', 'warehouse', 'clinical trial', 'patient care',
  'nursing', 'hospital', 'icu', 'medical device', 'retail store',
  'store manager', 'district manager', 'field technician', 'field service',
  'manufacturing plant', 'production line', 'assembly line',
  'truck', 'driver', 'fleet management', 'route optimization',
  'customer service representative', 'call center',
];

// Location filters
const EXCLUDE_LOCATIONS = [
  'london', 'united kingdom', ' uk,', ' uk ', 'emea', 'germany', 'france',
  'canada', 'toronto', 'vancouver', 'montreal', 'ontario', 'british columbia',
  'australia', 'singapore', 'india', 'apac', 'japan', 'mexico',
  'brazil', 'argentina', 'chile', 'bangalore', 'chennai', 'gurugram',
];

const REMOTE_SIGNALS = [
  'remote', 'anywhere', 'distributed', 'work from home', 'wfh',
  'us remote', 'usa remote', 'united states remote', 'north america remote', 'nationwide',
];

const BAY_AREA_SIGNALS = [
  'san francisco', 'sf,', ' sf ', 'bay area', 'palo alto', 'mountain view',
  'menlo park', 'san mateo', 'foster city', 'redwood city', 'sunnyvale',
  'santa clara', 'cupertino', 'campbell', 'san jose', 'oakland', 'berkeley',
  'burlingame', 'south san francisco', 'milpitas', 'fremont', 'pleasanton',
  'walnut creek', 'silicon valley', 'peninsula', 'emeryville', 'redwood shores',
];

// ── Scoring engine ────────────────────────────────────────────────────────────

function scoreJob({ title, department, description, location, company }) {
  const t = (title || '').toLowerCase();
  const dept = (department || '').toLowerCase();
  const desc = (description || '').toLowerCase();
  const loc = (location || '').toLowerCase();

  // 1. Location filter — disqualify non-US/remote immediately
  if (EXCLUDE_LOCATIONS.some(k => loc.includes(k))) return 0;
  const isRemote = REMOTE_SIGNALS.some(k => loc.includes(k));
  const isBayArea = BAY_AREA_SIGNALS.some(k => loc.includes(k));
  const noLocation = !loc || loc.length < 2;
  if (!isRemote && !isBayArea && !noLocation) return 0;

  // 2. Title disqualifiers — archive immediately
  if (TITLE_DISQUALIFIERS.some(k => t.includes(k))) return 0;

  // 3. Department disqualifiers
  if (BAD_DEPARTMENTS.some(k => dept.includes(k))) return 0;

  // 4. Description bad signals (only if description is substantial)
  if (desc.length > 200) {
    const badCount = BAD_DESCRIPTION_SIGNALS.filter(k => desc.includes(k)).length;
    if (badCount >= 2) return 0;
  }

  // 5. Exact title match — score 90
  if (TITLE_EXACT_TARGETS.some(k => t.includes(k))) return 90;

  // 6. Good department + any ops/strategy in title — score 85
  const hasGoodDept = GOOD_DEPARTMENTS.some(k => dept.includes(k));
  if (hasGoodDept && (t.includes('operations') || t.includes('strategy') || t.includes('program manager'))) {
    return 85;
  }

  // 7. Strong title pairs — score 82
  for (const [primary, qualifiers] of TITLE_STRONG_PAIRS) {
    if (t.includes(primary) && qualifiers.some(q => t.includes(q))) return 82;
  }

  // 8. Ambiguous title — check description for signals
  const isAmbiguous = t.includes('operations manager') || t.includes('program manager') ||
    t.includes('operations lead') || t.includes('strategy manager');

  if (isAmbiguous && desc.length > 200) {
    const goodCount = GOOD_DESCRIPTION_SIGNALS.filter(k => desc.includes(k)).length;
    if (goodCount >= 4) return 82;
    if (goodCount >= 2) return 78;
    return 0; // Ambiguous title + weak description = archive
  }

  // 9. Standalone "operations manager" or "strategy manager" without qualifiers
  // Only keep if from a known tech company list (covered by slug lists)
  if (t.includes('operations manager') || t.includes('operations lead') ||
      t.includes('operations director') || t.includes('strategy manager') ||
      t.includes('strategy lead')) {
    return 78; // From known tech company slugs, give benefit of doubt
  }

  // 10. Weak match — archive
  return 0;
}

// ── ATS URL patterns ──────────────────────────────────────────────────────────

// ── Greenhouse companies ──────────────────────────────────────────────────────
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

// ── Ashby companies ───────────────────────────────────────────────────────────
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

// ── Lever companies ───────────────────────────────────────────────────────────
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

      // Quick score without description first
      let score = scoreJob({ title, department, description: '', location, company: slug });

      // For ambiguous titles, fetch full content
      if (score === 78 || score === 82) {
        const needsContent = title.toLowerCase().includes('program manager') ||
          title.toLowerCase().includes('operations manager') ||
          title.toLowerCase() === 'operations lead';
        if (needsContent) {
          const content = await fetchGreenhouseJobWithContent(slug, j.id);
          score = scoreJob({ title, department, description: content, location, company: slug });
          await sleep(200); // Rate limit
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

// ── Insert jobs ───────────────────────────────────────────────────────────────

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

  // Split into queued (score >= 75) and archived (score < 75 but > 0)
  const toQueue = newJobs.filter(j => j.match_score >= 75);
  const toArchive = newJobs.filter(j => j.match_score > 0 && j.match_score < 75);

  let inserted = 0;
  if (toQueue.length > 0) {
    const { error } = await supabase.from('applications').insert(
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
      }))
    );
    if (!error) inserted = toQueue.length;
    else log(`  ❌ Insert error: ${error.message}`);
  }

  // Archive low-score jobs so they don't get re-discovered
  if (toArchive.length > 0) {
    await supabase.from('applications').insert(
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
      }))
    ).catch(() => {});
  }

  return { inserted, archived: toArchive.length };
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
  log(`   Greenhouse: ${GREENHOUSE_SLUGS.length} companies`);
  log(`   Ashby:      ${ASHBY_SLUGS.length} companies`);
  log(`   Lever:      ${LEVER_SLUGS.length} companies`);

  log('🔍 Fetching YC company job boards...');
  const ycSlugs = await fetchYCCompanies();

  const allGHSlugs = [...new Set([...GREENHOUSE_SLUGS, ...ycSlugs.greenhouse])];
  const allABSlugs = [...new Set([...ASHBY_SLUGS, ...ycSlugs.ashby])];
  const allLVSlugs = [...new Set([...LEVER_SLUGS, ...ycSlugs.lever])];

  log(`📋 Total: ${allGHSlugs.length} GH, ${allABSlugs.length} Ashby, ${allLVSlugs.length} Lever`);

  const ghJobs = await processBatch(allGHSlugs, fetchGreenhouseJobs, 'Greenhouse');
  const abJobs = await processBatch(allABSlugs, fetchAshbyJobs, 'Ashby', 1200);
  const lvJobs = await processBatch(allLVSlugs, fetchLeverJobs, 'Lever', 1000);

  const allJobs = [...ghJobs, ...abJobs, ...lvJobs];

  // Deduplicate by external_id
  const seen = new Set();
  const uniqueJobs = allJobs.filter(j => {
    if (!j.external_id || seen.has(j.external_id)) return false;
    seen.add(j.external_id);
    return true;
  });

  log(`\n📊 Scored jobs found:`);
  log(`   Score 90 (exact match): ${uniqueJobs.filter(j => j.match_score === 90).length}`);
  log(`   Score 85 (dept match):  ${uniqueJobs.filter(j => j.match_score === 85).length}`);
  log(`   Score 82 (strong pair): ${uniqueJobs.filter(j => j.match_score === 82).length}`);
  log(`   Score 78 (ambiguous):   ${uniqueJobs.filter(j => j.match_score === 78).length}`);
  log(`   Total queued (75+):     ${uniqueJobs.filter(j => j.match_score >= 75).length}`);

  const { inserted, archived } = await insertJobs(uniqueJobs);
  log(`\n✅ Inserted ${inserted} new jobs into queue`);
  log(`🗄 Archived ${archived} low-score jobs`);
  log(`⏭ Skipped ${uniqueJobs.length - inserted - archived} already in database`);
}

main().catch(err => {
  log(`💥 Fatal: ${err.message}`);
  process.exit(1);
});

/**
 * Job Autopilot — Search-based Job Discovery
 * Sources: Adzuna + JSearch + SerpApi
 * Scores jobs at insert time using same engine as discover-jobs-api.js
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const JSEARCH_API_KEY = process.env.JSEARCH_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Scoring engine (same as discover-jobs-api.js) ─────────────────────────────

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

const TITLE_STRONG_PAIRS = [
  ['operations', ['strategy', 'business', 'revenue', 'sales', 'gtm', 'growth', 'commercial', 'central', 'general']],
  ['strategy', ['operations', 'business', 'growth', 'corporate', 'commercial', 'revenue', 'sales', 'gtm']],
  ['program manager', ['operations', 'strategy', 'ops', 'sales', 'gtm', 'revenue', 'business', 'growth', 'transformation', 'strategic', 'product operations', 'commercial']],
  ['program director', ['operations', 'strategy', 'ops', 'sales', 'gtm', 'revenue', 'business']],
];

const GOOD_DEPARTMENTS = [
  'strategy', 'operations', 'business operations', 'revenue operations',
  'sales operations', 'gtm', 'go-to-market', 'growth', 'finance',
  'strategic finance', 'chief of staff', 'special projects',
  'business development', 'commercial', 'revenue',
];

const BAD_DEPARTMENTS = [
  'engineering', 'software', 'product', 'design', 'data science',
  'machine learning', 'infrastructure', 'security', 'legal', 'hr',
  'human resources', 'recruiting', 'talent', 'marketing', 'it ',
  'information technology', 'clinical', 'medical', 'nursing',
  'facilities', 'supply chain', 'logistics', 'manufacturing',
];

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
  // Physical ops disqualifiers — critical for open web search
  'store manager', 'district manager', 'regional manager', 'area manager',
  'shift supervisor', 'floor manager', 'branch manager',
  'warehouse manager', 'fulfillment', 'distribution center',
  'plant manager', 'production manager', 'manufacturing manager',
  'restaurant manager', 'food service', 'catering manager',
  'hotel manager', 'front desk', 'housekeeping',
  'nurse', 'clinical', 'patient', 'medical', 'pharmacy',
  'driver', 'delivery', 'route', 'trucker',
  'construction', 'contractor', 'foreman', 'superintendent',
];

const GOOD_DESCRIPTION_SIGNALS = [
  'cross-functional', 'stakeholder', 'p&l', 'okr', 'kpi', 'gtm',
  'go-to-market', 'revenue operations', 'sales operations', 'business operations',
  'strategy', 'operational excellence', 'process improvement', 'sql',
  'data-driven', 'analytics', 'reporting', 'roadmap', 'prioritization',
  'chief of staff', 'special projects', 'scaled', 'hypergrowth',
  'cross functional', 'program management', 'project management',
  'business intelligence', 'tableau', 'salesforce', 'hubspot',
  'annual planning', 'quarterly planning', 'headcount', 'budget',
  'saas', 'startup', 'series', 'venture', 'yc', 'y combinator',
  'seed', 'growth stage', 'scale-up', 'scaleup',
];

const BAD_DESCRIPTION_SIGNALS = [
  'plc', 'cnc', 'forklift', 'warehouse', 'clinical trial', 'patient care',
  'nursing', 'hospital', 'icu', 'medical device', 'retail store',
  'store manager', 'district manager', 'field technician', 'field service',
  'manufacturing plant', 'production line', 'assembly line',
  'truck', 'driver', 'fleet management', 'route optimization',
  'customer service representative', 'call center',
  'cvs', 'walgreens', 'target', 'walmart', 'costco', 'sephora', 'ulta',
  'macy', 'nordstrom', 'gap ', 'h&m', 'zara', 'uniqlo',
  'mcdonald', 'starbucks', 'chipotle', 'domino', 'subway',
];

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
  'walnut creek', 'silicon valley', 'peninsula',
];

// Open web search needs stricter scoring — no benefit of doubt for ambiguous titles
function scoreJobStrict({ title, department, description, location, company }) {
  const t = (title || '').toLowerCase();
  const dept = (department || '').toLowerCase();
  const desc = (description || '').toLowerCase();
  const loc = (location || '').toLowerCase();

  // Location filter
  if (EXCLUDE_LOCATIONS.some(k => loc.includes(k))) return 0;
  const isRemote = REMOTE_SIGNALS.some(k => loc.includes(k));
  const isBayArea = BAY_AREA_SIGNALS.some(k => loc.includes(k));
  const noLocation = !loc || loc.length < 2;
  if (!isRemote && !isBayArea && !noLocation) return 0;

  // Title disqualifiers
  if (TITLE_DISQUALIFIERS.some(k => t.includes(k))) return 0;

  // Department disqualifiers
  if (BAD_DEPARTMENTS.some(k => dept.includes(k))) return 0;

  // Description bad signals
  if (desc.length > 100) {
    const badCount = BAD_DESCRIPTION_SIGNALS.filter(k => desc.includes(k)).length;
    if (badCount >= 1) return 0; // Stricter for open web — one bad signal is enough
  }

  // Company name bad signals (open web includes retail/food companies)
  const companyLower = (company || '').toLowerCase();
  const badCompanies = ['cvs', 'walgreen', 'target', 'walmart', 'costco', 'sephora', 'ulta',
    'macy', 'nordstrom', 'gap', 'h&m', 'zara', 'uniqlo', 'mcdonald', 'starbucks',
    'chipotle', 'domino', 'subway', 'pizza', 'burger', 'taco', 'wendys',
    'dollar tree', 'dollar general', 'family dollar', 'autozone', 'advance auto',
    'lowes', 'home depot', 'bed bath', 'best buy', 'gamestop', 'petco', 'petsmart',
    'uhaul', 'enterprise rent', 'hertz', 'avis', 'budget rent',
    'marriott', 'hilton', 'hyatt', 'ihg', 'wyndham', 'choice hotel',
    'ups ', 'fedex', 'usps', 'dhl', 'xpo logistics', 'amazon logistics'];
  if (badCompanies.some(k => companyLower.includes(k))) return 0;

  // Exact title match
  if (TITLE_EXACT_TARGETS.some(k => t.includes(k))) return 90;

  // Good department match
  const hasGoodDept = GOOD_DEPARTMENTS.some(k => dept.includes(k));
  if (hasGoodDept && (t.includes('operations') || t.includes('strategy') || t.includes('program manager'))) {
    return 85;
  }

  // Strong title pairs
  for (const [primary, qualifiers] of TITLE_STRONG_PAIRS) {
    if (t.includes(primary) && qualifiers.some(q => t.includes(q))) return 82;
  }

  // For open web — ambiguous titles MUST have strong description signals
  const isAmbiguous = t.includes('operations manager') || t.includes('program manager') ||
    t.includes('operations lead') || t.includes('strategy manager');

  if (isAmbiguous) {
    if (desc.length < 100) return 0; // No description = too risky from open web
    const goodCount = GOOD_DESCRIPTION_SIGNALS.filter(k => desc.includes(k)).length;
    if (goodCount >= 5) return 82;
    if (goodCount >= 3) return 78;
    return 0; // Open web ambiguous title needs strong signals
  }

  return 0; // Open web: if it doesn't match clearly, archive it
}

// ── ATS URL parsing ───────────────────────────────────────────────────────────

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
      return { ats_type, ats_slug: match[1].toLowerCase(), external_id: match[2], url: url.split('?')[0] };
    }
  }
  return null;
}

// ── Search queries ────────────────────────────────────────────────────────────

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
        for (const u of candidateUrls) { atsInfo = parseAtsUrl(u); if (atsInfo) break; }
        if (!atsInfo && job.description) {
          const urlMatches = job.description.match(/https?:\/\/[^\s"'<>]+/g) || [];
          for (const u of urlMatches) { atsInfo = parseAtsUrl(u); if (atsInfo) break; }
        }
        if (!atsInfo) continue;

        const title = job.title || '';
        const location = job.location?.display_name || '';
        const company = job.company?.display_name || atsInfo.ats_slug;
        const description = job.description || '';
        const score = scoreJobStrict({ title, department: '', description, location, company });
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
        for (const u of candidateUrls) { atsInfo = parseAtsUrl(u); if (atsInfo) break; }
        if (!atsInfo) continue;

        const title = job.job_title || '';
        const location = `${job.job_city || ''} ${job.job_state || ''} ${job.job_country || ''}`.trim();
        const company = job.employer_name || atsInfo.ats_slug;
        const description = job.job_description || '';
        const score = scoreJobStrict({ title, department: '', description, location, company });
        if (score > 0) jobs.push({ job_title: title, company, source: 'jsearch', match_score: score, ...atsInfo, location });
      }

      log(`  ✓ JSearch "${query}"`);
      await sleep(1000);
    } catch(e) { log(`  ⚠ JSearch error: ${e.message}`); }
  }

  log(`✅ JSearch: ${jobs.length} relevant ATS jobs`);
  return jobs;
}

// ── SerpApi ───────────────────────────────────────────────────────────────────

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
        for (const u of candidateUrls) { atsInfo = parseAtsUrl(u); if (atsInfo) break; }
        if (!atsInfo) continue;

        const title = job.title || '';
        const location = job.location || '';
        const company = job.company_name || atsInfo.ats_slug;
        const description = job.description || '';
        const score = scoreJobStrict({ title, department: '', description, location, company });
        if (score > 0) jobs.push({ job_title: title, company, source: 'serpapi', match_score: score, ...atsInfo, location });
      }

      log(`  ✓ SerpApi "${query}"`);
      await sleep(1000);
    } catch(e) { log(`  ⚠ SerpApi error: ${e.message}`); }
  }

  log(`✅ SerpApi: ${jobs.length} relevant ATS jobs`);
  return jobs;
}

// ── Insert jobs ───────────────────────────────────────────────────────────────

async function insertJobs(jobs) {
  if (jobs.length === 0) return { inserted: 0, archived: 0 };

  const externalIds = jobs.map(j => j.external_id).filter(Boolean);
  const { data: existing } = await supabase.from('applications').select('external_id').in('external_id', externalIds);
  const existingIds = new Set((existing || []).map(e => e.external_id));
  const newJobs = jobs.filter(j => j.external_id && !existingIds.has(j.external_id));
  if (newJobs.length === 0) return { inserted: 0, archived: 0 };

  const toQueue = newJobs.filter(j => j.match_score >= 75);
  const toArchive = newJobs.filter(j => j.match_score > 0 && j.match_score < 75);

  let inserted = 0;
  if (toQueue.length > 0) {
    const { error } = await supabase.from('applications').insert(
      toQueue.map(j => ({
        job_title: j.job_title, company: j.company, ats_type: j.ats_type,
        ats_slug: j.ats_slug, external_id: j.external_id, url: j.url,
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
        ats_slug: j.ats_slug, external_id: j.external_id, url: j.url,
        location: j.location || '', status: 'archived', match_score: j.match_score, source: j.source,
      }))
    ).catch(() => {});
  }

  return { inserted, archived: toArchive.length };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('🚀 Starting search-based job discovery with inline scoring...');

  const [adzunaJobs, jsearchJobs, serpApiJobs] = await Promise.allSettled([
    fetchAdzuna(), fetchJSearch(), fetchSerpApi(),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

  const allJobs = [...adzunaJobs, ...jsearchJobs, ...serpApiJobs];
  const seen = new Set();
  const uniqueJobs = allJobs.filter(j => {
    if (!j.external_id || seen.has(j.external_id)) return false;
    seen.add(j.external_id); return true;
  });

  log(`\n📊 Scored jobs found: ${uniqueJobs.length}`);
  log(`   Score 90: ${uniqueJobs.filter(j => j.match_score === 90).length}`);
  log(`   Score 82: ${uniqueJobs.filter(j => j.match_score === 82).length}`);
  log(`   Score 78: ${uniqueJobs.filter(j => j.match_score === 78).length}`);

  const { inserted, archived } = await insertJobs(uniqueJobs);
  log(`\n✅ Inserted ${inserted} new jobs into queue`);
  log(`🗄 Archived ${archived} low-score jobs`);
  log(`⏭ Skipped ${uniqueJobs.length - inserted - archived} already in database`);
}

main().catch(err => { log(`💥 Fatal: ${err.message}`); process.exit(1); });

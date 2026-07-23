/**
 * lib/scoring.js -- CONSOLIDATED, FINAL VERSION
 *
 * Single scoring engine for both discover-jobs-api.js (company-API sources
 * -- Greenhouse/Ashby/Lever/SmartRecruiters/Workable/Workday, where the
 * company is already known/vetted) and discover-jobs.js (open web search
 * via Adzuna/JSearch/SerpApi, where companies are unvetted noise-prone).
 * Call scoreJob(input, { strict: true }) for the open-web case.
 *
 * Confirmed via this conversation: the scoring changes described in
 * project memory (Director-at-startup carve-out, Senior Director always 0,
 * product-ops/strategy-ops keyword additions, blank-location tightening)
 * were never actually implemented in the live discover-jobs-api.js /
 * discover-jobs.js. This version implements them for real, for the first
 * time, rather than assuming they already existed somewhere.
 */

const { normalizeLocation } = require('./location');

// ---- Title signals ---------------------------------------------------------

const TITLE_EXACT_TARGETS = [
  'strategy & operations', 'strategy and operations', 'strategic operations',
  'business operations', 'biz ops', 'bizops', 'biz-ops', 'business ops',
  'revenue operations', 'revops', 'rev ops',
  'gtm operations', 'gtm ops', 'gtm strategy', 'go-to-market operations',
  'sales operations', 'sales ops', 'sales strategy and operations',
  'sales strategy & operations', 'commercial operations',
  'special projects', 'strategic initiatives',
  'strategic planning', 'growth operations', 'growth ops', 'growth strategy',
  'corporate strategy', 'business strategy',
  // Additions per project memory, never actually implemented until now:
  'product operations', 'product ops',
  'strategy & ops', 'strategy and ops',
  'business strategy & operations', 'business strategy and operations',
  'gtm strategy & operations', 'gtm strategy and operations',
];

// Chief of Staff / Head of Operations are handled separately below (not in
// TITLE_EXACT_TARGETS) because they get a distinct, higher score at
// early-stage startups per memory: 95 at startup, 90 elsewhere.
const COS_HEAD_OF_OPS_TITLES = ['chief of staff', 'head of operations', 'head of ops'];

const TITLE_STRONG_PAIRS = [
  ['operations', ['strategy', 'business', 'revenue', 'sales', 'gtm', 'growth', 'commercial', 'central', 'general', 'product', 'customer success']],
  ['strategy', ['operations', 'business', 'growth', 'corporate', 'commercial', 'revenue', 'sales', 'gtm']],
  ['program manager', ['operations', 'strategy', 'ops', 'sales', 'gtm', 'revenue', 'business', 'growth', 'transformation', 'strategic', 'product operations', 'commercial']],
  ['program director', ['operations', 'strategy', 'ops', 'sales', 'gtm', 'revenue', 'business']],
];

const TITLE_HARD_DISQUALIFIERS = [
  'software engineer', 'software developer', 'frontend', 'backend', 'full stack',
  'devops', 'dev ops', 'data engineer', 'data scientist', 'ml engineer',
  'ai engineer', 'infrastructure engineer', 'platform engineer',
  'solutions engineer', 'sales engineer', 'security engineer',
  // Per memory: "Non-technical Program Manager titles use inverted
  // disqualifier logic" -- exclude the technical variant specifically,
  // while generic "program manager" stays eligible via TITLE_STRONG_PAIRS.
  'technical program manager',
  'store operations', 'retail operations', 'field operations', 'clinical operations',
  'warehouse operations', 'manufacturing operations', 'plant operations',
  'restaurant operations', 'hotel operations', 'fleet operations',
  'facilities operations', 'distribution operations', 'supply chain operations',
  'it operations', 'security operations', 'help desk', 'noc ',
  'account executive', 'account manager', 'sales representative', 'sales rep',
  'bdr ', 'sdr ', 'inside sales', 'outside sales',
  'product manager', 'product designer', 'ux ', 'ui ',
  'data analyst', 'financial analyst', 'accountant', 'controller',
  'legal counsel', 'attorney', 'paralegal',
  'recruiter', 'talent acquisition', 'hr business partner',
  'content writer', 'copywriter', 'graphic designer',
  'store manager', 'district manager', 'regional manager', 'shift supervisor',
  'warehouse manager', 'plant manager', 'restaurant manager', 'hotel manager',
  'nurse', 'clinical', 'patient', 'pharmacy',
  'driver', 'delivery', 'trucker', 'construction', 'foreman',
];

// ---- Seniority tiers --------------------------------------------------------

const SENIORITY_TIERS = {
  CSUITE: [' ceo', ' coo', ' cfo', ' cto', 'chief executive', 'chief operating',
    'chief financial', 'chief technology', 'chief revenue', 'chief product'],
  VP: ['vice president', 'vp ', 'svp', 'evp', 'associate vice president'],
  SENIOR_DIRECTOR: ['senior director', 'sr. director', 'sr director'],
  DIRECTOR: ['director', 'head of'],
  SENIOR_MANAGER: ['senior manager', 'sr. manager', 'sr manager'],
  MANAGER: ['manager', 'lead'],
};

function detectSeniority(title) {
  const t = title.toLowerCase();
  if (SENIORITY_TIERS.CSUITE.some(k => t.includes(k))) return 'CSUITE';
  // Check SENIOR_DIRECTOR before DIRECTOR -- more specific match first.
  if (SENIORITY_TIERS.SENIOR_DIRECTOR.some(k => t.includes(k))) return 'SENIOR_DIRECTOR';
  if (SENIORITY_TIERS.SENIOR_MANAGER.some(k => t.includes(k))) return 'SENIOR_MANAGER';
  if (SENIORITY_TIERS.VP.some(k => t.includes(k))) return 'VP';
  if (SENIORITY_TIERS.DIRECTOR.some(k => t.includes(k))) return 'DIRECTOR';
  if (SENIORITY_TIERS.MANAGER.some(k => t.includes(k))) return 'MANAGER';
  return 'UNSPECIFIED';
}

const STARTUP_SIGNALS = ['seed', 'series a', 'series b', 'pre-seed', 'early-stage', 'early stage'];

function isLikelyEarlyStage(description) {
  const d = (description || '').toLowerCase();
  return STARTUP_SIGNALS.some(k => d.includes(k));
}

// ---- Department / description signals --------------------------------------

const GOOD_DEPARTMENTS = [
  'strategy', 'operations', 'business operations', 'revenue operations',
  'sales operations', 'gtm', 'go-to-market', 'growth', 'finance',
  'strategic finance', 'chief of staff', 'special projects',
  'business development', 'commercial', 'revenue', 'product operations',
];

const BAD_DEPARTMENTS = [
  'engineering', 'software', 'product', 'design', 'data science',
  'machine learning', 'infrastructure', 'security', 'legal', 'hr',
  'human resources', 'recruiting', 'talent', 'marketing', 'it ',
  'information technology', 'clinical', 'medical', 'nursing',
  'facilities', 'supply chain', 'logistics', 'manufacturing',
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
];

// Open-web-only: known non-target employers that pollute Adzuna/JSearch/
// SerpApi results but never show up via direct company-API discovery.
const BAD_COMPANIES_OPEN_WEB = [
  'cvs', 'walgreen', 'target', 'walmart', 'costco', 'sephora', 'ulta',
  'macy', 'nordstrom', 'gap', 'h&m', 'zara', 'uniqlo', 'mcdonald', 'starbucks',
  'chipotle', 'domino', 'subway', 'pizza', 'burger', 'taco', 'wendys',
  'dollar tree', 'dollar general', 'family dollar', 'autozone', 'advance auto',
  'lowes', 'home depot', 'bed bath', 'best buy', 'gamestop', 'petco', 'petsmart',
  'uhaul', 'enterprise rent', 'hertz', 'avis', 'budget rent',
  'marriott', 'hilton', 'hyatt', 'ihg', 'wyndham', 'choice hotel',
  'ups ', 'fedex', 'usps', 'dhl', 'xpo logistics', 'amazon logistics',
];

const AGGREGATOR_COMPANY_NAMES = ['jobgether'];

// ---- Main scoring function --------------------------------------------------

function scoreJob({ title, department, description, location, company }, opts = {}) {
  const strict = !!opts.strict; // true for discover-jobs.js (open web)
  const t = (title || '').toLowerCase();
  const dept = (department || '').toLowerCase();
  const desc = (description || '').toLowerCase();
  const companyLower = (company || '').toLowerCase();
  const loc = normalizeLocation(location);

  // --- Location gate ---
  // Per memory: blank locations no longer auto-pass. Applies in both modes
  // now -- this was a deliberate tightening decision, not strict-only.
  if (loc.isExcludedCountry) return 0;
  if (!loc.isRemote && !loc.isBayArea) return 0;

  // --- Title hard disqualifiers ---
  if (TITLE_HARD_DISQUALIFIERS.some(k => t.includes(k))) return 0;

  // --- Department disqualifiers ---
  if (BAD_DEPARTMENTS.some(k => dept.includes(k))) return 0;

  // --- Description bad signals ---
  // Strict (open web): one bad signal is enough. Lenient (known company
  // API): needs two, since a single incidental mention is less suspicious
  // when the company itself is already a vetted tech/SaaS employer.
  if (desc.length > (strict ? 100 : 200)) {
    const badThreshold = strict ? 1 : 2;
    if (BAD_DESCRIPTION_SIGNALS.filter(k => desc.includes(k)).length >= badThreshold) return 0;
  }

  // --- Open-web-only: bad company blocklist ---
  if (strict && BAD_COMPANIES_OPEN_WEB.some(k => companyLower.includes(k))) return 0;

  // --- Seniority gate ---
  const seniority = detectSeniority(t);
  if (seniority === 'CSUITE') return 0;
  if (seniority === 'VP') return 0;
  if (seniority === 'SENIOR_DIRECTOR') return 0; // per memory: always 0, no exceptions
  if (seniority === 'DIRECTOR') {
    const isOpsDirector = t.includes('director of operations') || t.includes('operations director');
    if (!(isOpsDirector && isLikelyEarlyStage(desc))) return 0;
  }

  // --- Chief of Staff / Head of Operations special case ---
  // Per memory: 95 at startup, 90 elsewhere. Checked before the general
  // point-accumulation path since it has its own fixed scores.
  if (COS_HEAD_OF_OPS_TITLES.some(k => t.includes(k))) {
    return isLikelyEarlyStage(desc) ? 95 : 90;
  }

  // --- Point accumulation for everything else ---
  let points = 0;

  if (TITLE_EXACT_TARGETS.some(k => t.includes(k))) points += 55;
  else {
    for (const [primary, qualifiers] of TITLE_STRONG_PAIRS) {
      if (t.includes(primary) && qualifiers.some(q => t.includes(q))) { points += 47; break; }
    }
  }

  const hasGoodDept = GOOD_DEPARTMENTS.some(k => dept.includes(k));
  if (hasGoodDept) points += 15;

  if (desc.length > (strict ? 100 : 200)) {
    const goodCount = GOOD_DESCRIPTION_SIGNALS.filter(k => desc.includes(k)).length;
    points += Math.min(goodCount * 3, 18);
  }

  const isAmbiguousTitle = points === 0 && (
    t.includes('operations manager') || t.includes('program manager') ||
    t.includes('operations lead') || t.includes('strategy manager')
  );
  if (isAmbiguousTitle) {
    const minDescLen = strict ? 100 : 200;
    if (desc.length < minDescLen) return 0;
    const goodCount = GOOD_DESCRIPTION_SIGNALS.filter(k => desc.includes(k)).length;
    // Strict mode needs more signal -- no "benefit of doubt from known
    // company list" fallback exists for open-web sources.
    const minGoodCount = strict ? 3 : 2;
    if (goodCount < minGoodCount) return 0;
    points += Math.min(goodCount * 4, 30);
  }

  if (points === 0) return 0;

  if (seniority === 'SENIOR_MANAGER') points += 4;

  if (AGGREGATOR_COMPANY_NAMES.some(a => companyLower.includes(a))) points -= 15;

  return Math.max(0, Math.min(90, points));
}

module.exports = {
  scoreJob, detectSeniority, isLikelyEarlyStage,
  AGGREGATOR_COMPANY_NAMES, BAD_COMPANIES_OPEN_WEB,
};

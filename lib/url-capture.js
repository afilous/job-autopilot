/**
 * lib/url-capture.js -- NEW FILE
 *
 * Replaces the old strict ATS_PATTERNS regex parser in discover-jobs.js.
 * Old approach: only Greenhouse/Lever/Ashby URLs were recognized; anything
 * else was silently dropped, even if the job itself was a great match.
 * New approach: capture any job URL. ats_type is a best-effort label for
 * scoring/analytics context only -- Tsenta's fetch-job-description is the
 * real arbiter of whether a URL is submittable, not this label.
 */

// Best-effort ATS label from domain -- NOT used to gate anything downstream.
// Extend this list whenever you notice a new domain in Supabase's ats_type
// column coming back as 'unknown' for a site you recognize.
const ATS_DOMAIN_HINTS = [
  [/boards\.greenhouse\.io|job-boards\.greenhouse\.io/i, 'greenhouse'],
  [/jobs\.lever\.co/i, 'lever'],
  [/jobs\.ashbyhq\.com/i, 'ashby'],
  [/myworkdayjobs\.com/i, 'workday'],
  [/jobs\.smartrecruiters\.com/i, 'smartrecruiters'],
  [/(apply\.workable\.com|jobs\.workable\.com)/i, 'workable'],
  [/\.icims\.com/i, 'icims'],
  [/ats\.rippling\.com/i, 'rippling'],
  [/\.bamboohr\.com/i, 'bamboohr'],
  [/recruiting\.paylocity\.com/i, 'paylocity'],
  [/\.recruitee\.com/i, 'recruitee'],
  [/applytojob\.com/i, 'jazzhr'],
  [/\.breezy\.hr/i, 'breezyhr'],
  [/\.myworkdaysite\.com/i, 'workday'],
  [/oraclecloud\.com/i, 'oraclecloud'],
  [/ultipro\.com/i, 'ultipro'],
];

function guessAtsType(url) {
  for (const [regex, label] of ATS_DOMAIN_HINTS) {
    if (regex.test(url)) return label;
  }
  return 'unknown';
}

// Extract a best-guess company slug from a URL for de-duplication/display
// purposes only. Not required to be perfectly accurate -- the URL itself
// is the real dedup key.
function guessCompanySlug(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    // Most job-board URLs put the company slug as the first path segment,
    // or it's in the subdomain for company-hosted boards (workday, bamboohr).
    const subdomainMatch = u.hostname.match(/^([a-z0-9-]+)\.(wd\d+\.)?myworkdayjobs\.com$/i)
      || u.hostname.match(/^([a-z0-9-]+)\.bamboohr\.com$/i);
    if (subdomainMatch) return subdomainMatch[1].toLowerCase();
    if (parts.length > 0) return parts[0].toLowerCase();
    return u.hostname.toLowerCase();
  } catch (e) {
    return 'unknown';
  }
}

// Given a raw URL found anywhere in search results (Adzuna/JSearch/SerpApi
// description text, redirect_url, apply_url, etc.), decide if it looks like
// an actual job posting worth capturing at all -- filters obvious noise
// (social media links, generic company homepages, etc.) without requiring
// it to match a specific ATS pattern.
const JOB_URL_SIGNALS = [
  /\/jobs?\//i, /\/careers?\//i, /\/apply/i, /\/posting/i, /\/opening/i,
  /\/job-boards?\//i, /\/position/i, /\/req\//i, /\/vacanc/i,
];
const NON_JOB_DOMAINS = [
  /linkedin\.com\/(?!jobs)/i, /facebook\.com/i, /twitter\.com|x\.com/i,
  /instagram\.com/i, /youtube\.com/i, /glassdoor\.com/i, /indeed\.com\/(?!viewjob)/i,
];

function looksLikeJobUrl(url) {
  if (!url) return false;
  if (NON_JOB_DOMAINS.some(r => r.test(url))) return false;
  return JOB_URL_SIGNALS.some(r => r.test(url)) || ATS_DOMAIN_HINTS.some(([r]) => r.test(url));
}

module.exports = { guessAtsType, guessCompanySlug, looksLikeJobUrl };

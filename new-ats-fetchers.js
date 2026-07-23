/**
 * new-ats-fetchers.js -- ADD to discover-jobs-api.js
 *
 * Three new public, no-auth APIs verified against vendor documentation:
 *   - SmartRecruiters Posting API: developers.smartrecruiters.com/docs/endpoints
 *   - Workable public widget API: confirmed via community docs (no official
 *     page, but stable and widely used -- same caveat as any unofficial-but-
 *     working endpoint: monitor for silent breakage)
 *   - Recruitee public offers API: same style as Workable's widget endpoint
 *
 * IMPORTANT CAVEAT: unlike Greenhouse/Ashby/Lever, these are NOT guaranteed
 * available for every company on the platform:
 *   - SmartRecruiters: the public Posting API is tier-dependent. Some
 *     customers on lower plans don't have it enabled. A 404/empty response
 *     for a real SmartRecruiters company usually means their plan doesn't
 *     expose it, not a bug in this code.
 *   - Workable: same story -- some employers only publish to the
 *     jobs.workable.com marketplace, not the widget endpoint, and will
 *     silently return zero jobs. Not a bug either.
 * Build your company-slug lists incrementally as you confirm each one
 * actually returns data, same as you'd have done originally for Greenhouse.
 */

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- SmartRecruiters -----------------------------------------------------
// Verified: GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings

const SMARTRECRUITERS_SLUGS = [
  // Seed list -- expand as you confirm each company has the public feed
  // enabled. companyIdentifier is usually the company name/slug used in
  // their jobs.smartrecruiters.com URL, e.g. "ServiceNow", "Canva".
  'ServiceNow', 'Canva', 'Bosch', 'Visa', 'Square1', 'Atlassian',
  'SquareTrade1', 'Yelp',
];

async function fetchSmartRecruitersJobs(companyIdentifier, scoreJobFn) {
  try {
    const res = await fetch(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyIdentifier)}/postings?limit=100`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return []; // tier-dependent -- 404 is expected for many companies
    const data = await res.json();
    const postings = data.content || [];

    return postings
      .map(p => {
        const title = p.name || '';
        const location = [p.location?.city, p.location?.region, p.location?.country]
          .filter(Boolean).join(', ');
        const department = p.department?.label || '';
        const description = ''; // requires a second call to /postings/{id} for full text
        const score = scoreJobFn({ title, department, description, location, company: companyIdentifier });
        if (score === 0) return null;
        return {
          job_title: title,
          company: p.company?.name || companyIdentifier,
          ats_type: 'smartrecruiters',
          ats_slug: companyIdentifier.toLowerCase(),
          external_id: p.id,
          url: p.ref || `https://jobs.smartrecruiters.com/${companyIdentifier}/${p.id}`,
          location,
          match_score: score,
          source: 'smartrecruiters-api',
        };
      })
      .filter(Boolean);
  } catch (e) { return []; }
}

// ---- Workable -------------------------------------------------------------
// Verified: GET https://apply.workable.com/api/v1/widget/accounts/{clientname}

const WORKABLE_SLUGS = [
  // Seed list -- expand as confirmed. clientname is the account slug used
  // in apply.workable.com/{clientname}/ URLs.
  'huggingface',
];

async function fetchWorkableJobs(clientname, scoreJobFn) {
  try {
    const res = await fetch(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(clientname)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return []; // some employers only publish elsewhere -- expected
    const data = await res.json();
    const jobs = data.jobs || [];

    return jobs
      .map(j => {
        const title = j.title || '';
        const location = [j.city, j.state, j.country].filter(Boolean).join(', ')
          || (j.telecommuting ? 'Remote' : '');
        const department = j.department || '';
        const description = j.description || '';
        const score = scoreJobFn({ title, department, description, location, company: clientname });
        if (score === 0) return null;
        return {
          job_title: title,
          company: data.name || clientname,
          ats_type: 'workable',
          ats_slug: clientname.toLowerCase(),
          external_id: j.shortcode || j.id,
          url: j.url || `https://apply.workable.com/${clientname}/j/${j.shortcode}/`,
          location,
          match_score: score,
          source: 'workable-api',
        };
      })
      .filter(Boolean);
  } catch (e) { return []; }
}

// ---- Recruitee (bonus -- same public-widget pattern) -----------------------
// Verified: GET https://{clientname}.recruitee.com/api/offers/

const RECRUITEE_SLUGS = [
  // Seed list -- expand as confirmed.
];

async function fetchRecruiteeJobs(clientname, scoreJobFn) {
  try {
    const res = await fetch(
      `https://${clientname}.recruitee.com/api/offers/`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const offers = data.offers || [];

    return offers
      .map(o => {
        const title = o.title || '';
        const location = o.location || (o.remote ? 'Remote' : '');
        const department = o.department || '';
        const description = o.description || '';
        const score = scoreJobFn({ title, department, description, location, company: clientname });
        if (score === 0) return null;
        return {
          job_title: title,
          company: o.company_name || clientname,
          ats_type: 'recruitee',
          ats_slug: clientname.toLowerCase(),
          external_id: String(o.id),
          url: o.careers_url || `https://${clientname}.recruitee.com/o/${o.slug}`,
          location,
          match_score: score,
          source: 'recruitee-api',
        };
      })
      .filter(Boolean);
  } catch (e) { return []; }
}

module.exports = {
  SMARTRECRUITERS_SLUGS, fetchSmartRecruitersJobs,
  WORKABLE_SLUGS, fetchWorkableJobs,
  RECRUITEE_SLUGS, fetchRecruiteeJobs,
};

/**
 * Wire into discover-jobs-api.js main():
 *
 *   const srJobs = await processBatch(SMARTRECRUITERS_SLUGS,
 *     slug => fetchSmartRecruitersJobs(slug, scoreJob), 'SmartRecruiters', 500);
 *   const wkJobs = await processBatch(WORKABLE_SLUGS,
 *     slug => fetchWorkableJobs(slug, scoreJob), 'Workable', 500);
 *   const rcJobs = await processBatch(RECRUITEE_SLUGS,
 *     slug => fetchRecruiteeJobs(slug, scoreJob), 'Recruitee', 500);
 *
 *   const allJobs = [...ghJobs, ...abJobs, ...lvJobs, ...srJobs, ...wkJobs, ...rcJobs];
 */

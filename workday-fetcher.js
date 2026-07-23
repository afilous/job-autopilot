/**
 * workday-fetcher.js -- NEW module for discover-jobs-api.js
 *
 * Fixes the root cause behind the Adobe episode: Tsenta's own discovery
 * crawl is NOT comprehensive. Its get-job-recommendations feed never
 * surfaced Adobe's Phenom-hosted (careers.adobe.com) postings even though
 * those same jobs, mirrored on Workday, were fully submittable. Waiting on
 * Tsenta (or manually browsing LinkedIn) to find these is not a strategy --
 * this fetcher queries Workday's own public API directly, same as the
 * existing Greenhouse/Ashby/Lever fetchers do for their platforms.
 *
 * VERIFIED REAL: Workday's "CXS" endpoint. No auth, no key.
 *   POST https://{tenant}.{wdServer}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *   Body: { appliedFacets: {}, limit, offset, searchText: "" }
 *
 * CAVEATS (be aware, don't over-promise):
 *   - Each tenant has its own wdServer (wd1, wd3, wd5, wd12, wd108, wd501...)
 *     and site slug (varies wildly: "external_experienced", "careers",
 *     "External_Career_Site", "jllcareers", etc.) -- there is no way to
 *     guess these reliably. You have to grab them once from a real job URL
 *     for that company (which you already have plenty of, from this
 *     session's research) and hardcode them into the tenant list below.
 *   - Workday sits behind Akamai bot management. Keep concurrency low and
 *     add delays (same politeness pattern as your other fetchers) or you
 *     risk getting blocked.
 *   - Search endpoint returns only title/location/path -- full description
 *     requires a second GET to /wday/cxs/{tenant}/{site}/job/{externalPath}.
 *     Only fetch full descriptions for jobs that already pass a title-only
 *     score check, same optimization discover-jobs-api.js already uses for
 *     Greenhouse ambiguous titles.
 */

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Tenant config ----------------------------------------------------
// { tenant, wdServer, site } extracted from real URLs found this session.
// Format of a real URL: https://{tenant}.{wdServer}.myworkdayjobs.com/{site}/job/...
// Extend this list any time you encounter a new company's Workday URL --
// just read the subdomain (tenant.wdServer) and the first path segment (site).
const WORKDAY_TENANTS = [
  { company: 'Adobe',        tenant: 'adobe',       wdServer: 'wd5',   site: 'external_experienced' },
  { company: 'Visa',         tenant: 'visa',        wdServer: 'wd5',   site: 'visa' },
  { company: 'Unity',        tenant: 'unitytech',   wdServer: 'wd1',   site: 'unity' },
  { company: 'Marvell',      tenant: 'marvell',     wdServer: 'wd1',   site: 'marvellcareers' },
  { company: 'Zillow',       tenant: 'zillow',      wdServer: 'wd5',   site: 'zillow_group_external' },
  { company: 'Genesys',      tenant: 'genesys',     wdServer: 'wd1',   site: 'genesys' },
  { company: 'Capital One',  tenant: 'capitalone',  wdServer: 'wd12',  site: 'capital_one' },
  { company: 'JLL',          tenant: 'jll',         wdServer: 'wd1',   site: 'jllcareers' },
  { company: 'Gilead',       tenant: 'gilead',      wdServer: 'wd1',   site: 'kitepharmacareers' },
  { company: 'Novartis',     tenant: 'novartis',    wdServer: 'wd3',   site: 'novartis_careers' },
  { company: 'Cisco',        tenant: 'cisco',       wdServer: 'wd5',   site: 'cisco_careers' },
  { company: 'DaVita',       tenant: 'davita',      wdServer: 'wd1',   site: 'dkc_external' },
  { company: 'HP',           tenant: 'hp',          wdServer: 'wd5',   site: 'exteu-ac-careersite' },
  { company: 'Workday',      tenant: 'workday',     wdServer: 'wd5',   site: 'workday' },
  { company: 'Lendistry',    tenant: 'lendistry',   wdServer: 'wd108', site: 'careers_join_us' },
  { company: 'Rosendin',     tenant: 'rosendin',    wdServer: 'wd1',   site: 'careers' },
  { company: 'The RealReal', tenant: 'therealreal', wdServer: 'wd1',   site: 'careers' },
  // Add more as you find them -- one real job URL is all you need per company.
];

// ---- Fetch job list for one tenant --------------------------------------

async function fetchWorkdayJobs(tenantConfig, scoreJobFn, searchText = '') {
  const { company, tenant, wdServer, site } = tenantConfig;
  const baseUrl = `https://${tenant}.${wdServer}.myworkdayjobs.com`;
  const searchUrl = `${baseUrl}/wday/cxs/${tenant}/${site}/jobs`;

  const results = [];
  let offset = 0;
  const PAGE_SIZE = 20;
  const MAX_PAGES = 15; // safety cap -- 300 jobs per company per run

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const res = await fetch(searchUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Accept-Language': 'en-US',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': `${baseUrl}/en-US/${site}`,
        },
        body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { log(`  ⚠ Workday ${company}: HTTP ${res.status}`); break; }
      const data = await res.json();
      const postings = data.jobPostings || [];
      if (postings.length === 0) break;

      for (const p of postings) {
        const title = p.title || '';
        const location = p.locationsText || p.locations?.[0]?.descriptor || '';
        // Title-only score first -- avoids fetching full descriptions for
        // obvious non-matches, same optimization as the Greenhouse fetcher.
        const quickScore = scoreJobFn({ title, department: '', description: '', location, company });
        if (quickScore === 0) continue;

        const externalPath = p.externalPath || '';
        const jobUrl = `${baseUrl}/en-US/${site}${externalPath}`;

        results.push({
          job_title: title,
          company,
          ats_type: 'workday',
          ats_slug: tenant,
          external_id: p.bulletFields?.[0] || externalPath, // requisition id when present
          url: jobUrl,
          location,
          match_score: quickScore, // description-based rescoring can happen at apply-review time
          source: 'workday-api',
        });
      }

      if (postings.length < PAGE_SIZE) break; // last page
      offset += PAGE_SIZE;
      await sleep(400); // politeness -- Akamai will block aggressive scraping
    } catch (e) {
      log(`  ⚠ Workday ${company} error: ${e.message}`);
      break;
    }
  }

  return results;
}

// ---- Batch runner across all configured tenants -------------------------

async function fetchAllWorkdayJobs(scoreJobFn) {
  const allJobs = [];
  for (const tenantConfig of WORKDAY_TENANTS) {
    log(`  🔍 Workday: ${tenantConfig.company}...`);
    const jobs = await fetchWorkdayJobs(tenantConfig, scoreJobFn);
    log(`    → ${jobs.length} relevant postings`);
    allJobs.push(...jobs);
    await sleep(1000); // politeness between companies
  }
  return allJobs;
}

module.exports = { WORKDAY_TENANTS, fetchWorkdayJobs, fetchAllWorkdayJobs };

/**
 * Wire into discover-jobs-api.js main():
 *
 *   const { fetchAllWorkdayJobs } = require('./workday-fetcher');
 *   const wdJobs = await fetchAllWorkdayJobs(scoreJob);
 *   const allJobs = [...ghJobs, ...abJobs, ...lvJobs, ...srJobs, ...wkJobs, ...wdJobs];
 *
 * This runs alongside (not instead of) Tsenta -- Tsenta still handles
 * submission for everything. This fetcher's whole job is discovery: make
 * sure jobs at these companies enter your Supabase queue automatically,
 * instead of requiring you to manually browse LinkedIn and hand me URLs.
 */

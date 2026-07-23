/**
 * workday-fetcher.js
 *
 * Fixes the root cause behind the Adobe episode: Tsenta's own discovery
 * crawl is NOT comprehensive. Its get-job-recommendations feed never
 * surfaced Adobe's Phenom-hosted (careers.adobe.com) postings even though
 * those same jobs, mirrored on Workday, were fully submittable. This
 * fetcher queries Workday's own public API directly, same as the
 * Greenhouse/Ashby/Lever fetchers do for their platforms.
 *
 * VERIFIED REAL: Workday's "CXS" endpoint. No auth, no key.
 *   POST https://{tenant}.{wdServer}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *   Body: { appliedFacets: {}, limit, offset, searchText: "" }
 *
 * The hardcoded WORKDAY_TENANTS list below is now a FLOOR, not the source
 * of truth -- discover-companies.js's site: search discovery finds new
 * Workday tenants and writes them to the `workday_tenants` Supabase table.
 * fetchAllWorkdayJobs() accepts those as an extra param and unions them
 * with this hardcoded list, same pattern already used for Greenhouse/
 * Ashby/Lever/SmartRecruiters/Workable in discover-jobs-api.js.
 *
 * CAVEATS:
 *   - Each tenant has its own wdServer (wd1, wd3, wd5, wd12, wd108...) and
 *     site slug -- there is no way to guess these. discover-companies.js
 *     extracts them automatically from real job URLs found via search.
 *   - Workday sits behind Akamai bot management. Keep concurrency low.
 *   - Search endpoint returns only title/location/path -- full description
 *     requires a second GET, not implemented here (score on title/location
 *     first pass, same optimization the Greenhouse fetcher uses).
 */

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Seed/floor list -- extracted from real URLs found during manual research
// this session. Extend only as a fallback; discover-companies.js should be
// the primary way this list grows going forward.
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
];

// ---- Fetch job list for one tenant --------------------------------------

async function fetchWorkdayJobs(tenantConfig, scoreJobFn, searchText = '') {
  const { company, tenant, wdServer, site } = tenantConfig;
  const baseUrl = `https://${tenant}.${wdServer}.myworkdayjobs.com`;
  const searchUrl = `${baseUrl}/wday/cxs/${tenant}/${site}/jobs`;

  const results = [];
  let offset = 0;
  const PAGE_SIZE = 20;
  const MAX_PAGES = 15;

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
        const quickScore = scoreJobFn({ title, department: '', description: '', location, company });
        if (quickScore === 0) continue;

        const externalPath = p.externalPath || '';
        const jobUrl = `${baseUrl}/en-US/${site}${externalPath}`;

        results.push({
          job_title: title,
          company,
          ats_type: 'workday',
          ats_slug: tenant,
          external_id: p.bulletFields?.[0] || externalPath,
          url: jobUrl,
          location,
          match_score: quickScore,
          source: 'workday-api',
        });
      }

      if (postings.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      await sleep(400);
    } catch (e) {
      log(`  ⚠ Workday ${company} error: ${e.message}`);
      break;
    }
  }

  return results;
}

// ---- Batch runner across all configured tenants -------------------------
// extraTenants: array of { company, tenant, wdServer, site } from Supabase's
// workday_tenants table, unioned with the hardcoded floor above.

async function fetchAllWorkdayJobs(scoreJobFn, extraTenants = []) {
  const seen = new Set();
  const allTenants = [];
  for (const t of [...WORKDAY_TENANTS, ...extraTenants]) {
    const key = `${t.tenant}|${t.wdServer}|${t.site}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allTenants.push(t);
  }

  log(`  📋 Workday tenants to check: ${allTenants.length} (${WORKDAY_TENANTS.length} floor + ${extraTenants.length} from Supabase, deduped)`);

  const allJobs = [];
  for (const tenantConfig of allTenants) {
    log(`  🔍 Workday: ${tenantConfig.company}...`);
    const jobs = await fetchWorkdayJobs(tenantConfig, scoreJobFn);
    log(`    → ${jobs.length} relevant postings`);
    allJobs.push(...jobs);
    await sleep(1000);
  }
  return allJobs;
}

module.exports = { WORKDAY_TENANTS, fetchWorkdayJobs, fetchAllWorkdayJobs };

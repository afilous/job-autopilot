/**
 * Job Autopilot — Discover Companies
 *
 * REWRITTEN: the old version crawled sitemap.xml files for Greenhouse,
 * Lever, and Ashby. As of this rewrite, all three are confirmed dead:
 *   - boards.greenhouse.io/sitemap.xml -> 404
 *   - jobs.lever.co/sitemap.xml -> 404
 *   - jobs.ashbyhq.com/sitemap.xml -> 200, but it's the React app shell
 *     (a client-side-routed SPA that serves the same HTML for any
 *     unmatched path), not real XML -- zero <loc> tags to parse, so this
 *     one was silently returning 0 companies even when it "succeeded."
 * No official Greenhouse documentation ever describes a public sitemap
 * listing every customer's board, so this may never have been reliable.
 *
 * REPLACED WITH: the site: search technique (verified working this
 * session -- found real companies on both Ashby and Greenhouse that
 * weren't in any hardcoded list), now also extended to discover new
 * Workday tenants automatically via site:*.myworkdayjobs.com searches.
 *
 * DESIGN GOAL (per explicit preference): no permanent hardcoded company
 * list as the source of truth. Once a company is discovered here (by any
 * means -- site search, YC list, or manually added), it's persisted to
 * Supabase and gets checked on every subsequent discover-jobs-api.js run
 * (daily). "Important companies get checked frequently" falls out
 * naturally from "everything discovered gets checked daily" -- there's no
 * need for a separate always-hardcoded VIP list.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ── Insert companies in batches ───────────────────────────────────────────────

async function insertCompanies(companies) {
  const BATCH_SIZE = 100;
  let inserted = 0;

  for (let i = 0; i < companies.length; i += BATCH_SIZE) {
    const batch = companies.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('companies')
      .upsert(batch, { onConflict: 'ats_slug', ignoreDuplicates: true });

    if (error) log(`  ❌ Batch insert error: ${error.message}`);
    else inserted += batch.length;

    if (i + BATCH_SIZE < companies.length) await sleep(200);
  }

  return inserted;
}

async function insertWorkdayTenants(tenants) {
  if (tenants.length === 0) return 0;
  const { error } = await supabase
    .from('workday_tenants')
    .upsert(tenants, { onConflict: 'tenant,wd_server,site', ignoreDuplicates: true });

  if (error) { log(`  ❌ Workday tenant insert error: ${error.message}`); return 0; }
  return tenants.length;
}

// ── YC company discovery (unchanged — real, working Algolia endpoint) ────────

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
  } catch (e) { return { greenhouse: [], ashby: [], lever: [] }; }
}

async function discoverYC() {
  log('🌱 Fetching YC company job boards...');
  const ycSlugs = await fetchYCCompanies();

  const companies = [
    ...ycSlugs.greenhouse.map(slug => ({ name: cap(slug), ats_type: 'greenhouse', ats_slug: slug, active: true })),
    ...ycSlugs.ashby.map(slug => ({ name: cap(slug), ats_type: 'ashby', ats_slug: slug, active: true })),
    ...ycSlugs.lever.map(slug => ({ name: cap(slug), ats_type: 'lever', ats_slug: slug, active: true })),
  ];

  const inserted = await insertCompanies(companies);
  log(`  ✅ YC: ${inserted} companies processed`);
  return inserted;
}

function cap(slug) { return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '); }

// ── ATS URL parsing (same logic as lib/url-capture.js, inlined so this ───────
//    file has no dependency on discover-jobs.js's requires) ──────────────────

const ATS_DOMAIN_HINTS = [
  [/boards\.greenhouse\.io|job-boards\.greenhouse\.io/i, 'greenhouse'],
  [/jobs\.lever\.co/i, 'lever'],
  [/jobs\.ashbyhq\.com/i, 'ashby'],
  [/jobs\.smartrecruiters\.com/i, 'smartrecruiters'],
  [/(apply\.workable\.com|jobs\.workable\.com)/i, 'workable'],
];

function guessAtsType(url) {
  for (const [regex, label] of ATS_DOMAIN_HINTS) if (regex.test(url)) return label;
  return 'unknown';
}

function guessCompanySlug(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length > 0 ? parts[0].toLowerCase() : u.hostname.toLowerCase();
  } catch (e) { return 'unknown'; }
}

// Extracts { tenant, wdServer, site } from a Workday job URL.
// Handles both with and without an /en-US/-style locale prefix:
//   https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/...
//   https://jll.wd1.myworkdayjobs.com/jllcareers/job/...
function parseWorkdayUrl(url) {
  const m = url.match(/^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-zA-Z]{2}-[A-Z]{2}\/)?([^/]+)\//i);
  if (!m) return null;
  return { tenant: m[1].toLowerCase(), wdServer: m[2].toLowerCase(), site: m[3] };
}

// ── Site: search discovery ────────────────────────────────────────────────────
// Budget: 8 domains x 3 title groups = 24 calls/run, weekly cadence
// (~104/month). Combined with discover-jobs.js's ~120/month, stays under
// SerpApi's 250/month free-tier limit with buffer. Do not increase title
// groups or add domains without re-checking this math against your plan.

const ATS_SITE_DOMAINS = [
  'jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io',
  'jobs.lever.co', 'jobs.smartrecruiters.com', 'apply.workable.com', 'jobs.workable.com',
];

const WORKDAY_SITE_DOMAIN = 'myworkdayjobs.com';

const SITE_SEARCH_TITLE_GROUPS = [
  '"strategy and operations" OR "strategy & operations" OR "business operations manager"',
  '"chief of staff" OR "biz ops" OR "revenue operations manager"',
  '"gtm operations" OR "product operations" OR "commercial operations manager"',
];

async function siteSearch(domain, titleGroup) {
  if (!SERPAPI_KEY) return [];
  try {
    const q = `site:${domain} ${titleGroup}`;
    const params = new URLSearchParams({ engine: 'google', q, num: '20', api_key: SERPAPI_KEY });
    const res = await fetch(`https://serpapi.com/search?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { log(`  ⚠ SerpApi ${res.status} for site:${domain}`); return []; }
    const data = await res.json();
    return (data.organic_results || []).map(r => r.link).filter(Boolean);
  } catch (e) {
    log(`  ⚠ Site search error (${domain}): ${e.message}`);
    return [];
  }
}

async function discoverViaSiteSearch() {
  if (!SERPAPI_KEY) { log('⏭ Site search discovery: no SERPAPI_KEY configured'); return { companies: 0, workdayTenants: 0 }; }

  log('🔍 Discovering companies via site: search (Greenhouse/Ashby/Lever/SmartRecruiters/Workable)...');
  const newCompanySlugs = { greenhouse: new Set(), ashby: new Set(), lever: new Set(), smartrecruiters: new Set(), workable: new Set() };

  for (const domain of ATS_SITE_DOMAINS) {
    for (const titleGroup of SITE_SEARCH_TITLE_GROUPS) {
      const urls = await siteSearch(domain, titleGroup);
      for (const url of urls) {
        const atsType = guessAtsType(url);
        const slug = guessCompanySlug(url);
        if (slug && slug !== 'unknown' && newCompanySlugs[atsType]) newCompanySlugs[atsType].add(slug);
      }
      log(`  ✓ site:${domain} "${titleGroup.slice(0, 30)}..." → ${urls.length} hits`);
      await sleep(1200);
    }
  }

  const companies = [];
  for (const [atsType, slugs] of Object.entries(newCompanySlugs)) {
    for (const slug of slugs) companies.push({ name: cap(slug), ats_type: atsType, ats_slug: slug, active: true });
  }
  const companiesInserted = await insertCompanies(companies);
  log(`  ✅ Site search (ATS companies): ${companiesInserted} companies processed`);

  log('🔍 Discovering Workday tenants via site: search...');
  const newTenants = new Map(); // keyed by tenant|wdServer|site to dedupe within this run

  for (const titleGroup of SITE_SEARCH_TITLE_GROUPS) {
    const urls = await siteSearch(WORKDAY_SITE_DOMAIN, titleGroup);
    for (const url of urls) {
      const parsed = parseWorkdayUrl(url);
      if (!parsed) continue;
      const key = `${parsed.tenant}|${parsed.wdServer}|${parsed.site}`;
      if (!newTenants.has(key)) {
        newTenants.set(key, { company: cap(parsed.tenant), tenant: parsed.tenant, wd_server: parsed.wdServer, site: parsed.site, active: true });
      }
    }
    log(`  ✓ site:${WORKDAY_SITE_DOMAIN} "${titleGroup.slice(0, 30)}..." → ${urls.length} hits`);
    await sleep(1200);
  }

  const tenantsInserted = await insertWorkdayTenants([...newTenants.values()]);
  log(`  ✅ Site search (Workday tenants): ${tenantsInserted} tenants processed`);

  return { companies: companiesInserted, workdayTenants: tenantsInserted };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('🚀 Starting company discovery...');

  const ycCount = await discoverYC();
  await sleep(1000);
  const { companies: siteCompanyCount, workdayTenants: siteWorkdayCount } = await discoverViaSiteSearch();

  log(`\n────────────────────────────────`);
  log(`✅ Total processed:`);
  log(`   YC companies:         ${ycCount}`);
  log(`   Site search companies: ${siteCompanyCount}`);
  log(`   Workday tenants:       ${siteWorkdayCount}`);
}

main().catch(err => {
  log(`💥 Fatal error: ${err.message}`);
  process.exit(1);
});

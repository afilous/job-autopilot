/**
 * ats-site-search-discovery.js -- NEW module for discover-jobs.js
 *
 * Solves the core problem directly: your hardcoded GREENHOUSE_SLUGS /
 * ASHBY_SLUGS / LEVER_SLUGS lists (~100-150 companies) miss the vast
 * majority of companies actually posting S&O roles on these platforms.
 * Verified this session via manual site: search -- a single query on
 * Ashby surfaced 8 companies NOT in your hardcoded list (Hadrian, Hang,
 * Pear VC, Emergence Capital, Sound Ventures, Socure, cosmos GmbH, 0g
 * Labs, Puzzle.io); a single Greenhouse query surfaced 8 more (ResortPass,
 * Snapdocs, Bluevine, Revel, B-Stock, YipitData, Pursuit, Mural Health).
 *
 * APPROACH: use SerpApi's `google` engine (not `google_jobs`) with a
 * `site:` operator per ATS domain, combined with rotating S&O title
 * queries. This uses the SERPAPI_KEY you already have configured --
 * no new credentials needed.
 *
 * KEY DESIGN CHOICE: every hit's company slug gets extracted and fed back
 * as a *new tenant/company to track going forward* -- not just scored as
 * a one-off job. One search match for a company means you now pull ALL
 * of that company's postings via the existing direct-API fetchers
 * (Greenhouse/Ashby/Lever functions already in discover-jobs-api.js, or
 * the new Workday fetcher), rather than only the single title that
 * happened to match this specific search query.
 */

const { guessAtsType, guessCompanySlug, looksLikeJobUrl } = require('./lib/url-capture');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Domains to search -- extend as you confirm new ATS platforms are worth it.
const ATS_SITE_DOMAINS = [
  'jobs.ashbyhq.com',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.smartrecruiters.com',
  'apply.workable.com',
  'jobs.workable.com',
];

// Rotate through these -- one query per (domain, title-group) combo.
// Grouped with OR to get more coverage per API call (SerpApi charges per
// call, not per result, so packing multiple titles into one query is free
// coverage). Split into multiple groups since very long OR chains can
// suppress results on some search backends.
const TITLE_QUERY_GROUPS = [
  '"strategy and operations" OR "strategy & operations" OR "business operations manager"',
  '"chief of staff" OR "biz ops" OR "bizops"',
  '"revenue operations manager" OR "gtm operations" OR "sales strategy and operations"',
  '"product operations" OR "growth operations" OR "commercial operations manager"',
  '"head of operations" OR "director of operations" startup',
];

// ---- Run one site:-restricted search -------------------------------------

async function searchAtsSite(domain, titleQuery) {
  if (!SERPAPI_KEY) { log('  ⏭ No SERPAPI_KEY -- skipping site search discovery'); return []; }
  try {
    const q = `site:${domain} ${titleQuery}`;
    const params = new URLSearchParams({ engine: 'google', q, num: '20', api_key: SERPAPI_KEY });
    const res = await fetch(`https://serpapi.com/search?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { log(`  ⚠ SerpApi ${res.status} for site:${domain} "${titleQuery.slice(0,30)}..."`); return []; }
    const data = await res.json();
    const organic = data.organic_results || [];
    return organic.map(r => r.link).filter(Boolean);
  } catch (e) {
    log(`  ⚠ Site search error (${domain}): ${e.message}`);
    return [];
  }
}

// ---- Main runner ------------------------------------------------------

// Returns { newCompanySlugs: { greenhouse: [...], ashby: [...], lever: [...],
//   smartrecruiters: [...], workable: [...] }, urls: [...] (raw hits for
//   optional direct scoring/insertion too) }
async function discoverViaAtsSiteSearch() {
  const newSlugsByAts = {
    greenhouse: new Set(), ashby: new Set(), lever: new Set(),
    smartrecruiters: new Set(), workable: new Set(),
  };
  const allUrls = [];

  for (const domain of ATS_SITE_DOMAINS) {
    for (const titleQuery of TITLE_QUERY_GROUPS) {
      log(`  🔍 site:${domain} "${titleQuery.slice(0, 40)}..."`);
      const urls = await searchAtsSite(domain, titleQuery);
      log(`    → ${urls.length} hits`);

      for (const url of urls) {
        if (!looksLikeJobUrl(url)) continue;
        allUrls.push(url);
        const atsType = guessAtsType(url);
        const slug = guessCompanySlug(url);
        if (slug && slug !== 'unknown' && newSlugsByAts[atsType]) {
          newSlugsByAts[atsType].add(slug);
        }
      }
      await sleep(1200); // politeness -- SerpApi rate limits + avoid hammering
    }
  }

  return {
    newCompanySlugs: {
      greenhouse: [...newSlugsByAts.greenhouse],
      ashby: [...newSlugsByAts.ashby],
      lever: [...newSlugsByAts.lever],
      smartrecruiters: [...newSlugsByAts.smartrecruiters],
      workable: [...newSlugsByAts.workable],
    },
    urls: allUrls,
  };
}

module.exports = { discoverViaAtsSiteSearch, ATS_SITE_DOMAINS, TITLE_QUERY_GROUPS };

/**
 * Wire into discover-jobs.js or discover-companies.js main():
 *
 *   const { discoverViaAtsSiteSearch } = require('./ats-site-search-discovery');
 *   const { newCompanySlugs } = await discoverViaAtsSiteSearch();
 *
 *   // Upsert newly-found companies into Supabase (same pattern as
 *   // discover-companies.js's insertCompanies -- onConflict: 'ats_slug',
 *   // ignoreDuplicates: true), so discover-jobs-api.js's Supabase-driven
 *   // fetchers (once that fix from earlier is in) automatically pick up
 *   // every job at these newly-found companies going forward, not just
 *   // the one title that matched today's search.
 *
 *   for (const [atsType, slugs] of Object.entries(newCompanySlugs)) {
 *     if (slugs.length === 0) continue;
 *     await supabase.from('companies').upsert(
 *       slugs.map(slug => ({
 *         name: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
 *         ats_type: atsType, ats_slug: slug, active: true,
 *       })),
 *       { onConflict: 'ats_slug', ignoreDuplicates: true }
 *     );
 *   }
 *
 * COST NOTE: 7 domains x 5 title groups = 35 SerpApi calls per run. Check
 * your SerpApi plan's monthly call limit before scheduling this to run
 * daily -- weekly is a safer starting cadence, same as discover-companies.yml.
 */

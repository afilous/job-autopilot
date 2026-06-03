/**
 * Job Autopilot — Discover All Companies from ATS Sitemaps
 * Fetches Greenhouse, Lever, and Ashby sitemaps and inserts all companies into Supabase
 * Run manually: node discover-companies.js
 * Or trigger via GitHub Actions
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Parse XML sitemap and extract slugs ───────────────────────────────────────
function extractSlugsFromSitemap(xml, urlPattern) {
  const slugs = new Set();
  const matches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
  for (const match of matches) {
    const url = match[1];
    const result = urlPattern(url);
    if (result) slugs.add(result);
  }
  return [...slugs];
}

// ── Fetch with retry ──────────────────────────────────────────────────────────
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobAutopilot/1.0)' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return await res.text();
      log(`  ⚠ HTTP ${res.status} for ${url}`);
    } catch (e) {
      log(`  ⚠ Attempt ${i + 1} failed: ${e.message}`);
      if (i < retries - 1) await sleep(2000);
    }
  }
  return null;
}

// ── Insert companies in batches ───────────────────────────────────────────────
async function insertCompanies(companies) {
  const BATCH_SIZE = 100;
  let inserted = 0;

  for (let i = 0; i < companies.length; i += BATCH_SIZE) {
    const batch = companies.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('companies')
      .upsert(batch, { onConflict: 'ats_slug', ignoreDuplicates: true });

    if (error) {
      log(`  ❌ Batch insert error: ${error.message}`);
    } else {
      inserted += batch.length;
    }

    if (i + BATCH_SIZE < companies.length) await sleep(200);
  }

  return inserted;
}

// ── Greenhouse ────────────────────────────────────────────────────────────────
async function discoverGreenhouse() {
  log('🌱 Fetching Greenhouse sitemap...');
  const xml = await fetchWithRetry('https://boards.greenhouse.io/sitemap.xml');
  if (!xml) { log('❌ Failed to fetch Greenhouse sitemap'); return 0; }

  const slugs = extractSlugsFromSitemap(xml, (url) => {
    // URLs like: https://boards.greenhouse.io/stripe
    // or: https://boards.greenhouse.io/stripe/jobs/123
    const match = url.match(/boards\.greenhouse\.io\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    if (match && match[1] !== 'embed' && match[1] !== 'api') {
      return match[1].toLowerCase();
    }
    return null;
  });

  log(`  📋 Found ${slugs.length} Greenhouse companies`);

  const companies = slugs.map(slug => ({
    name: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
    ats_type: 'greenhouse',
    ats_slug: slug,
    active: true,
  }));

  const inserted = await insertCompanies(companies);
  log(`  ✅ Greenhouse: ${inserted} companies processed`);
  return inserted;
}

// ── Lever ─────────────────────────────────────────────────────────────────────
async function discoverLever() {
  log('🌱 Fetching Lever sitemap...');
  const xml = await fetchWithRetry('https://jobs.lever.co/sitemap.xml');
  if (!xml) { log('❌ Failed to fetch Lever sitemap'); return 0; }

  const slugs = extractSlugsFromSitemap(xml, (url) => {
    // URLs like: https://jobs.lever.co/stripe/job-id
    const match = url.match(/jobs\.lever\.co\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    if (match) return match[1].toLowerCase();
    return null;
  });

  log(`  📋 Found ${slugs.length} Lever companies`);

  const companies = slugs.map(slug => ({
    name: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
    ats_type: 'lever',
    ats_slug: slug,
    active: true,
  }));

  const inserted = await insertCompanies(companies);
  log(`  ✅ Lever: ${inserted} companies processed`);
  return inserted;
}

// ── Ashby ─────────────────────────────────────────────────────────────────────
async function discoverAshby() {
  log('🌱 Fetching Ashby sitemap...');
  const xml = await fetchWithRetry('https://jobs.ashbyhq.com/sitemap.xml');
  if (!xml) { log('❌ Failed to fetch Ashby sitemap'); return 0; }

  const slugs = extractSlugsFromSitemap(xml, (url) => {
    // URLs like: https://jobs.ashbyhq.com/ramp/job-id
    const match = url.match(/jobs\.ashbyhq\.com\/([a-zA-Z0-9_.-]+)(?:\/|$)/);
    if (match && !match[1].includes('.')) return match[1].toLowerCase();
    return null;
  });

  log(`  📋 Found ${slugs.length} Ashby companies`);

  const companies = slugs.map(slug => ({
    name: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
    ats_type: 'ashby',
    ats_slug: slug,
    active: true,
  }));

  const inserted = await insertCompanies(companies);
  log(`  ✅ Ashby: ${inserted} companies processed`);
  return inserted;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('🚀 Starting company discovery...');

  const gh = await discoverGreenhouse();
  await sleep(1000);
  const lv = await discoverLever();
  await sleep(1000);
  const ab = await discoverAshby();

  log(`\n────────────────────────────────`);
  log(`✅ Total processed:`);
  log(`   Greenhouse: ${gh}`);
  log(`   Lever:      ${lv}`);
  log(`   Ashby:      ${ab}`);
  log(`   Total:      ${gh + lv + ab}`);
}

main().catch(err => {
  log(`💥 Fatal error: ${err.message}`);
  process.exit(1);
});

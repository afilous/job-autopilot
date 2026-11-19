/**
 * Job Autopilot — Startup job newsletter discovery (Substack, free, no API key)
 *
 * Every Substack newsletter has a public RSS feed at <publication>/feed. Job
 * newsletters like Next Play list hiring startups with a link to the company's
 * job board (Greenhouse, Ashby, Lever, Workable, SmartRecruiters). This script
 * reads those feeds, pulls out every job-board link, and saves each company's
 * board to the `companies` table. The daily ATS discovery run
 * (discover-jobs-api.js) then scans those boards in full and scores every role,
 * so one newsletter mention turns into all of that startup's matching jobs.
 *
 * Newsletters are listed in the Supabase table `job_newsletters`
 * (name, feed_url, active). Add a row to add a newsletter; no code change.
 * If the table is empty or missing, the DEFAULT_FEEDS below are used.
 *
 * Env vars:
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *   LOOKBACK_DAYS (optional, default 21)  how far back to read posts
 *   DRY_RUN=true  (optional)              print what would be saved, write nothing
 */

const { createClient } = require('@supabase/supabase-js');
const { guessAtsType } = require('./lib/url-capture');
const { logRun } = require('./lib/runlog');

const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '21', 10);
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

const DEFAULT_FEEDS = [
  { name: 'Next Play', feed_url: 'https://nextplayso.substack.com/feed' },
  { name: 'Ali Rohde Jobs', feed_url: 'https://alirohdejobs.substack.com/feed' },
];

const BOARD_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters']);
const BAD_SLUGS = new Set([
  'embed', 'jobs', 'job', 'careers', 'career', 'apply', 'www', 'j', 'p', 'api', 'v1', 'boards', 'company', 'about',
]);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function cap(s) { return String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

function decode(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

// ── RSS parsing ──────────────────────────────────────────────────────────────

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

/** Returns [{ title, link, date, html }] for each <item> in an RSS feed. */
function parseFeed(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    const block = m[1];
    items.push({
      title: decode(tag(block, 'title')).trim(),
      link: decode(tag(block, 'link')).trim(),
      date: new Date(decode(tag(block, 'pubDate')).trim()),
      html: decode(tag(block, 'content:encoded')) || decode(tag(block, 'description')),
    });
  }
  return items;
}

// ── Pull job-board companies out of post HTML ───────────────────────────────

function slugFromUrl(url, atsType) {
  try {
    const u = new URL(url);
    const forParam = u.searchParams.get('for'); // boards.greenhouse.io/embed/job_app?for=slug
    if (forParam) return forParam.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    if (atsType === 'smartrecruiters' && parts[0].toLowerCase() === 'oneclick-ui') return null;
    return parts[0].toLowerCase();
  } catch (e) {
    return null;
  }
}

/** Returns a Map of "ats:slug" -> { ats_type, ats_slug, name, example_url }. */
function extractCompanies(html) {
  const found = new Map();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(String(html || ''))) !== null) {
    const url = decode(m[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const ats = guessAtsType(url);
    if (!BOARD_ATS.has(ats)) continue;
    if (/jobs\.workable\.com/i.test(url)) continue; // slug is not in this URL form
    const slug = slugFromUrl(url, ats);
    if (!slug || !/^[a-z0-9][a-z0-9_.-]{1,60}$/.test(slug) || BAD_SLUGS.has(slug)) continue;
    const key = `${ats}:${slug}`;
    if (!found.has(key)) found.set(key, { ats_type: ats, ats_slug: slug, name: cap(slug), example_url: url });
  }
  return found;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function loadFeeds(supabase) {
  const { data, error } = await supabase.from('job_newsletters').select('name, feed_url').eq('active', true);
  if (error || !data || data.length === 0) {
    if (error) log(`  (job_newsletters table not readable: ${error.message}; using default feeds)`);
    return DEFAULT_FEEDS;
  }
  return data;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.feed_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobAutopilot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { log(`  ⚠ ${feed.name}: HTTP ${res.status}`); return null; }
    return await res.text();
  } catch (e) {
    log(`  ⚠ ${feed.name}: ${e.message}`);
    return null;
  }
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const feeds = await loadFeeds(supabase);
  const cutoff = Date.now() - LOOKBACK_DAYS * 86400000;
  log(`🚀 Newsletter discovery — ${feeds.length} feed(s), last ${LOOKBACK_DAYS} days${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const all = new Map();
  let failed = 0;

  for (const feed of feeds) {
    const xml = await fetchFeed(feed);
    if (xml === null) { failed++; continue; }
    const items = parseFeed(xml).filter(i => !isNaN(i.date) && i.date.getTime() >= cutoff);
    let boards = 0;
    for (const item of items) {
      for (const [key, co] of extractCompanies(item.html)) {
        if (!all.has(key)) { all.set(key, { ...co, source: feed.name }); boards++; }
      }
    }
    log(`  ${feed.name}: ${items.length} recent post(s), ${boards} new job-board link(s)`);
  }

  if (failed === feeds.length) {
    const msg = `All ${feeds.length} newsletter feeds failed to load`;
    await logRun(supabase, 'discover-newsletters', { errors: failed, notes: msg });
    throw new Error(msg);
  }

  const rows = [...all.values()].map(c => ({ name: c.name, ats_type: c.ats_type, ats_slug: c.ats_slug, active: true }));
  log(`📊 ${rows.length} distinct company job boards found in newsletters`);

  if (DRY_RUN) {
    for (const c of all.values()) log(`   ${c.ats_type}/${c.ats_slug}  (${c.source})  ${c.example_url}`);
    return;
  }

  let added = 0;
  if (rows.length > 0) {
    const { data, error } = await supabase
      .from('companies')
      .upsert(rows, { onConflict: 'ats_slug', ignoreDuplicates: true })
      .select('ats_slug');
    if (error) {
      await logRun(supabase, 'discover-newsletters', { found: rows.length, errors: 1, notes: `save failed: ${error.message}` });
      throw new Error(`Saving companies failed: ${error.message}`);
    }
    added = (data || []).length;
  }
  log(`✅ Added ${added} new companies to the scan list (${rows.length - added} already known)`);
  await logRun(supabase, 'discover-newsletters', { found: rows.length, inserted: added, errors: failed, notes: `feeds=${feeds.length}` });
}

module.exports = { parseFeed, extractCompanies, slugFromUrl };

if (require.main === module) {
  main().catch(err => {
    log(`💥 Fatal: ${err.message}`);
    process.exit(1);
  });
}

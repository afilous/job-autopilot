/**
 * Job Autopilot — Funded-startup discovery
 *
 * Early-stage startups that just raised money are the ones hiring a first Chief
 * of Staff, Head of Ops or Biz Ops lead, often before the role is widely posted.
 * This script:
 *   1. searches funding news (TechCrunch, FinSMEs, press-release wires, ...) for
 *      "X raises $N seed / Series A / B" in the last day (or SEARCH_WINDOW),
 *   2. pulls out the company, the stage and the amount from each headline,
 *   3. looks for that company's job board (Ashby, Greenhouse, Lever, Workable,
 *      SmartRecruiters) with a second search, retrying for a few days because new
 *      startups often post roles later,
 *   4. saves the board to `companies`, so the daily ATS scan (discover-jobs-api.js)
 *      reads every role there and scores it like any other source.
 * Everything is recorded in the Supabase table `funded_startups`
 * (view `funded_startups_status`).
 *
 * MODE=news (default, daily headlines), backfill (past year, by sector), enrich (funding
 * stage for companies already in the job list; finds startups that raised a year or two ago).
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, search keys (see lib/search.js),
 *      SEARCH_WINDOW d|w|m|y|a, MAX_LOOKUPS (default 25), DRY_RUN=true
 */

const { createClient } = require('@supabase/supabase-js');
const { createSearcher } = require('./lib/search');
const { guessAtsType } = require('./lib/url-capture');
const { logRun } = require('./lib/runlog');
const { slugFromUrl } = require('./discover-newsletters');

const MODE = (process.env.MODE || 'news').toLowerCase(); // news | backfill | enrich
const WINDOW = process.env.SEARCH_WINDOW || (MODE === 'backfill' ? 'y' : MODE === 'enrich' ? 'a' : 'd');
const MAX_LOOKUPS = parseInt(process.env.MAX_LOOKUPS || '25', 10);
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

const NEWS_DOMAINS = [
  'techcrunch.com', 'finsmes.com', 'prnewswire.com', 'businesswire.com', 'globenewswire.com',
  'venturebeat.com', 'siliconangle.com', 'geekwire.com', 'axios.com', 'news.crunchbase.com',
];
const FUNDING_QUERIES = [
  'raises seed round startup',
  'raises Series A startup',
  'raises Series B startup',
  'announces seed funding',
  'announces Series A funding led by',
  'emerges from stealth with funding',
  'raises pre-seed funding',
  'secures million funding round to scale',
];
const SECTORS = ['AI', 'fintech', 'healthcare', 'developer tools', 'cybersecurity', 'climate', 'enterprise software SaaS', 'marketplace', 'robotics hardware', 'logistics supply chain', 'consumer', 'biotech'];
const BACKFILL_QUERIES = SECTORS.flatMap(sec => [`${sec} startup raises seed round`, `${sec} startup raises Series A`]);
const BOARDS = ['jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co', 'apply.workable.com', 'jobs.smartrecruiters.com'];
const BOARD_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters']);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ── Headline parsing ─────────────────────────────────────────────────────────

const VERBS = '(?:raises|raised|secures|secured|lands|landed|closes|closed|bags|nabs|snags|gets|receives|announces|launches with|emerges from stealth with|unveils)';
const HEADLINE_RE = new RegExp(`^(.{2,60}?)\\s+${VERBS}\\s+(?:an?\\s+|new\\s+)?(?:US)?\\$\\s?([\\d.,]+)\\s?(million|billion|m|b|k)?\\b`, 'i');
const NOT_A_STARTUP = /\b(fund|capital|ventures|partners|holdings|acquisition|bank|etf|trust)\b/i;

function stageOf(text) {
  const t = String(text || '').toLowerCase();
  if (/pre-?seed/.test(t)) return 'pre-seed';
  if (/\bseed\b/.test(t)) return 'seed';
  const m = t.match(/series\s+([a-h])\b/);
  return m ? `series ${m[1]}` : null;
}

function amountOf(num, unit) {
  const n = parseFloat(String(num).replace(/,/g, ''));
  if (isNaN(n)) return null;
  const u = String(unit || '').toLowerCase();
  const mult = u.startsWith('b') ? 1e9 : u.startsWith('m') ? 1e6 : u === 'k' ? 1e3 : 1;
  return Math.round(n * mult);
}

/** "Acme raises $12M Series A to ..." -> { name, stage, amount_usd } or null */
function parseHeadline(title, snippet, { allowLate = false } = {}) {
  const t = String(title || '').replace(/^(exclusive|breaking|update)\s*[:\-–]\s*/i, '').replace(/\s+[|–—-]\s+[A-Za-z .]*$/, '').trim();
  const m = t.match(HEADLINE_RE);
  if (!m) return null;
  let name = m[1].replace(/^["'“”]+|["'“”,:]+$/g, '').trim();
  name = name.replace(/^[A-Z][a-z]+'s\s+(?=\S)/, '');
  if (!name || name.split(/\s+/).length > 5 || NOT_A_STARTUP.test(name)) return null;
  if (/^(how|why|what|these|this|the best|top|\d+)/i.test(name)) return null;
  const stage = stageOf(t) || stageOf(String(snippet || '').slice(0, 300));
  if (!stage) return null;
  const amount = amountOf(m[2], m[3]);
  if (!allowLate && (amount !== null && amount > 150e6 || /^series [c-h]$/.test(stage))) return null; // not early stage
  return { name, stage, amount_usd: amount };
}

/** Latest plausible year (2019..now) from a URL, headline or snippet. */
function yearOf(...texts) {
  const now = new Date().getFullYear();
  const years = [];
  for (const t of texts) for (const m of String(t || '').matchAll(/(?:^|[^0-9])(20[12][0-9])(?![0-9])/g)) { const y = +m[1]; if (y >= 2019 && y <= now) years.push(y); }
  return years.length ? Math.max(...years) : null;
}

const keyOf = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');

// ── Board lookup ─────────────────────────────────────────────────────────────

/** Picks a job-board link whose slug plausibly belongs to the company. */
function boardFromResults(name, results) {
  const nk = keyOf(name);
  for (const r of results || []) {
    const ats = guessAtsType(r.link);
    if (!BOARD_ATS.has(ats)) continue;
    const slug = slugFromUrl(r.link, ats);
    if (!slug) continue;
    const sk = keyOf(slug);
    if (sk.length >= 3 && (nk.startsWith(sk) || sk.startsWith(nk.slice(0, Math.max(4, Math.min(nk.length, 6)))) || nk.includes(sk))) {
      return { ats_type: ats, ats_slug: slug };
    }
  }
  return null;
}

// ── Enrich: funding stage for companies already in the job list ──────────────
// Startups that raised a year or two ago are not in today's news. For every
// company that has a queued apply/review job, search for its funding history and
// record the latest round. The Supabase classifier uses this for Chief of Staff /
// Head-of roles (early-stage only).

async function enrich(supabase, searcher) {
  const { data: rows, error } = await supabase.from('applications')
    .select('company').in('fit_tier', ['apply', 'review']).in('status', ['queued', 'manual']).limit(5000);
  if (error) throw new Error(`Reading companies failed: ${error.message}`);
  const names = new Map();
  for (const r of rows || []) { const k = keyOf(r.company || ''); if (k.length >= 3 && !names.has(k)) names.set(k, r.company); }

  const { data: known } = await supabase.from('funded_startups').select('name_key').limit(10000);
  const have = new Set((known || []).map(r => r.name_key));
  const todo = [...names.entries()].filter(([k]) => !have.has(k)).slice(0, MAX_LOOKUPS);
  log(`🏢 ${names.size} companies with open jobs, ${names.size - todo.length - [...names.keys()].filter(k => have.has(k)).length} still unchecked after this batch; checking ${todo.length} now`);

  let withStage = 0, unknown = 0, failed = 0;
  const out = [];
  for (const [key, name] of todo) {
    const results = await searcher.search(`"${name}" raises funding round seed OR "Series A" OR "Series B" OR "Series C"`, null);
    if (results === null) { failed++; continue; }
    let best = null;
    for (const r of results) {
      const h = parseHeadline(r.title, r.snippet, { allowLate: true });
      if (!h) continue;
      const hk = keyOf(h.name);
      if (!(hk === key || hk.startsWith(key) || key.startsWith(hk))) continue; // headline must be about this company
      const year = yearOf(r.link, r.title);
      if (!best || (year || 0) > (best.announced_year || 0)) best = { ...h, announced_year: year, headline: r.title, source_url: r.link };
    }
    if (best) { withStage++; log(`   ✔ ${name}: ${best.stage}${best.announced_year ? ` (${best.announced_year})` : ''}`); }
    else { unknown++; }
    out.push({
      name, name_key: key, source: 'enrich', lookups: 1, last_lookup_at: new Date().toISOString(),
      stage: best ? best.stage : 'unknown', amount_usd: best ? best.amount_usd : null,
      announced_year: best ? best.announced_year : null, headline: best ? best.headline : null,
      source_url: best && !/^https?:\/\/(www\.)?google\./i.test(best.source_url || '') ? best.source_url : null,
    });
  }
  log(`✅ Funding stage found for ${withStage}, nothing found for ${unknown}, ${failed} searches failed${DRY_RUN ? ' (dry run, nothing saved)' : ''}`);
  if (failed === todo.length && todo.length > 0) {
    const msg = `All ${failed} enrich searches failed (see view api_quota_status)`;
    await logRun(supabase, 'discover-funded-startups', { errors: failed, notes: msg });
    throw new Error(msg);
  }
  if (DRY_RUN) return;
  if (out.length) {
    const { error: e2 } = await supabase.from('funded_startups').upsert(out, { onConflict: 'name_key', ignoreDuplicates: true });
    if (e2) throw new Error(`Saving enrich results failed: ${e2.message}`);
  }
  await logRun(supabase, 'discover-funded-startups', { found: withStage, inserted: out.length, errors: failed, notes: `mode=enrich providers=${JSON.stringify(searcher.used)}` });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const searcher = createSearcher({ supabase, window: WINDOW, mode: 'first', log });
  if (searcher.providers.length === 0) {
    const msg = 'No search API key set (see lib/search.js)';
    await logRun(supabase, 'discover-funded-startups', { errors: 1, notes: msg });
    throw new Error(msg);
  }
  if (MODE === 'enrich') return enrich(supabase, searcher);
  const QUERIES = MODE === 'backfill' ? BACKFILL_QUERIES : FUNDING_QUERIES;
  log(`🚀 Funded-startup discovery (${MODE}) via ${searcher.providers.join('>')} — window ${WINDOW}${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // 1. Funding headlines
  const found = new Map();
  let failed = 0;
  for (const q of QUERIES) {
    const results = await searcher.search(q, NEWS_DOMAINS);
    if (results === null) { failed++; continue; }
    let kept = 0;
    for (const r of results) {
      const h = parseHeadline(r.title, r.snippet);
      if (!h) continue;
      const k = keyOf(h.name);
      if (k.length < 3 || found.has(k)) continue;
      found.set(k, { ...h, name_key: k, source: MODE === 'backfill' ? 'backfill' : 'news', announced_year: yearOf(r.link, r.title) || (WINDOW === 'y' || WINDOW === 'a' ? null : new Date().getFullYear()), headline: r.title, source_url: /^https?:\/\/(www\.)?google\./i.test(r.link || '') ? null : r.link });
      kept++;
    }
    log(`  "${q}": ${results.length} result(s), ${kept} new company(ies)`);
  }
  if (failed === QUERIES.length) {
    const msg = `All ${failed} funding searches failed (keys wrong or free budgets used up: see view api_quota_status)`;
    await logRun(supabase, 'discover-funded-startups', { errors: failed, notes: msg });
    throw new Error(msg);
  }
  log(`📰 ${found.size} funded startups in the headlines`);

  if (DRY_RUN) {
    for (const c of found.values()) log(`   ${c.name} — ${c.stage}${c.amount_usd ? ` — $${(c.amount_usd / 1e6).toFixed(1)}M` : ''} — ${c.source_url}`);
  } else if (found.size > 0) {
    const { error } = await supabase.from('funded_startups')
      .upsert([...found.values()], { onConflict: 'name_key', ignoreDuplicates: true });
    if (error) throw new Error(`Saving funded_startups failed: ${error.message}`);
  }

  // 2. Find job boards for companies that don't have one yet
  let pending = [];
  if (DRY_RUN) {
    pending = [...found.values()].slice(0, MAX_LOOKUPS).map(c => ({ ...c, lookups: 0 }));
  } else {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    const { data, error } = await supabase.from('funded_startups')
      .select('id, name, name_key, lookups')
      .is('ats_slug', null).lt('lookups', 4)
      .or(`last_lookup_at.is.null,last_lookup_at.lt.${twoDaysAgo}`)
      .order('found_at', { ascending: false }).limit(MAX_LOOKUPS);
    if (error) throw new Error(`Reading pending companies failed: ${error.message}`);
    pending = data || [];
  }
  log(`🔎 Looking for job boards: ${pending.length} compan(ies)`);

  let boards = 0;
  for (const c of pending) {
    const results = await searcher.search(`"${c.name}" careers jobs`, BOARDS);
    const board = results ? boardFromResults(c.name, results) : null;
    if (board) {
      boards++;
      log(`   ✔ ${c.name} → ${board.ats_type}/${board.ats_slug}`);
    } else {
      log(`   – ${c.name}: no board yet`);
    }
    if (DRY_RUN) continue;
    if (board) {
      await supabase.from('companies')
        .upsert([{ name: c.name, ats_type: board.ats_type, ats_slug: board.ats_slug, active: true }], { onConflict: 'ats_slug', ignoreDuplicates: true });
    }
    await supabase.from('funded_startups').update({
      lookups: (c.lookups || 0) + 1,
      last_lookup_at: new Date().toISOString(),
      ...(board ? { ats_type: board.ats_type, ats_slug: board.ats_slug, board_found_at: new Date().toISOString() } : {}),
    }).eq('id', c.id);
  }

  log(`✅ ${found.size} funded startups seen, ${boards} job boards found${DRY_RUN ? ' (dry run, nothing saved)' : ''}`);
  if (!DRY_RUN) {
    await logRun(supabase, 'discover-funded-startups', {
      found: found.size, inserted: boards, errors: failed,
      notes: `providers=${JSON.stringify(searcher.used)} window=${WINDOW}`,
    });
  }
}

module.exports = { parseHeadline, boardFromResults, stageOf, yearOf };

if (require.main === module) {
  main().catch(err => { log(`💥 Fatal: ${err.message}`); process.exit(1); });
}

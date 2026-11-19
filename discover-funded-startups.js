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
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, search keys (see lib/search.js),
 *      SEARCH_WINDOW d|w|m (default d), MAX_LOOKUPS (default 25), DRY_RUN=true
 */

const { createClient } = require('@supabase/supabase-js');
const { createSearcher } = require('./lib/search');
const { guessAtsType } = require('./lib/url-capture');
const { logRun } = require('./lib/runlog');
const { slugFromUrl } = require('./discover-newsletters');

const WINDOW = process.env.SEARCH_WINDOW || 'd';
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
  const m = t.match(/series\s+([abc])\b/);
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
function parseHeadline(title, snippet) {
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
  if (amount !== null && amount > 150e6) return null; // not early stage
  return { name, stage, amount_usd: amount };
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const searcher = createSearcher({ supabase, window: WINDOW, mode: 'first', log });
  if (searcher.providers.length === 0) {
    const msg = 'No search API key set (see lib/search.js)';
    await logRun(supabase, 'discover-funded-startups', { errors: 1, notes: msg });
    throw new Error(msg);
  }
  log(`🚀 Funded-startup discovery via ${searcher.providers.join('>')} — window ${WINDOW}${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // 1. Funding headlines
  const found = new Map();
  let failed = 0;
  for (const q of FUNDING_QUERIES) {
    const results = await searcher.search(q, NEWS_DOMAINS);
    if (results === null) { failed++; continue; }
    let kept = 0;
    for (const r of results) {
      const h = parseHeadline(r.title, r.snippet);
      if (!h) continue;
      const k = keyOf(h.name);
      if (k.length < 3 || found.has(k)) continue;
      found.set(k, { ...h, name_key: k, headline: r.title, source_url: /^https?:\/\/(www\.)?google\./i.test(r.link || '') ? null : r.link });
      kept++;
    }
    log(`  "${q}": ${results.length} result(s), ${kept} new company(ies)`);
  }
  if (failed === FUNDING_QUERIES.length) {
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

module.exports = { parseHeadline, boardFromResults, stageOf };

if (require.main === module) {
  main().catch(err => { log(`💥 Fatal: ${err.message}`); process.exit(1); });
}

/**
 * Job Autopilot — LinkedIn resolver
 *
 * LinkedIn alert emails give us only company + title (+ location now). Tsenta
 * cannot open LinkedIn links, so this script finds the employer's OWN posting:
 *
 *   1. Take unresolved LinkedIn rows (queued/manual, url still on linkedin.com)
 *   2. Find the company's job board (companies table first, then probe likely
 *      slugs on Greenhouse, Ashby, Lever, Workable, SmartRecruiters)
 *   3. Match the LinkedIn title against that board's open postings
 *   4. On a match: replace the url with the direct apply link, fill in the real
 *      location, and let the database trigger re-classify the row
 *   5. Remember every board we identify (companies table) so the daily board
 *      run polls the whole company, not just this one posting
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY
 *      DRY_RUN=true     print what would change, write nothing
 *      MAX_ROWS=300     rows to attempt per run
 *      CONCURRENCY=6    companies resolved in parallel
 *
 * Not covered: companies on Workday / iCIMS / custom career sites. Those rows
 * are marked link_status='unresolved' and stay visible in job_inbox so you can
 * apply manually.
 */

const { createClient } = require('@supabase/supabase-js');
const { logRun } = require('./lib/runlog');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_ROWS = parseInt(process.env.MAX_ROWS || '300', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '6', 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Normalisation ─────────────────────────────────────────────────────────────

function companyKey(name) {
  return String(name || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]/g, '');
}

const SUFFIX_RE = /\b(inc|llc|ltd|limited|corp|corporation|co|company|group|holdings|technologies|technology|labs|software|usa|us)\b\.?/gi;

// Candidate board slugs for a company name, most likely first.
function slugCandidates(company) {
  const base = String(company || '').replace(/&amp;/g, '&').replace(/\(.*?\)/g, ' ').trim();
  const noSuffix = base.replace(SUFFIX_RE, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = new Set();
  for (const name of [noSuffix, base]) {
    const words = name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    out.add(words.join(''));
    out.add(words.join('-'));
    if (words.length > 1) out.add(words[0]);
  }
  return [...out].filter(s => s.length >= 2).slice(0, 4);
}

function normTitle(t) {
  return String(t || '').toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\s*[\(\[][^)\]]*[\)\]]\s*/g, ' ')   // drop "(Remote)", "[Hybrid]"
    .replace(/\s*[-–—|]\s*(remote|hybrid|onsite|on-site|us|usa|united states).*$/i, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\bsr\b/g, 'senior')
    .replace(/\s+/g, ' ').trim();
}

function titleSimilarity(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const sx = new Set(x.split(' ')), sy = new Set(y.split(' '));
  let inter = 0;
  for (const w of sx) if (sy.has(w)) inter++;
  return inter / (sx.size + sy.size - inter);
}

const MIN_SIMILARITY = 0.88; // effectively exact title; LinkedIn copies the employer's title

// ── Board readers: return [{ title, location, url, external_id }] or null ───
// null = no such board; [] = board exists but empty.

async function getJson(url, opts = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0 };
  }
}

const READERS = {
  async greenhouse(slug) {
    const r = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`);
    if (!r.ok) return null;
    const meta = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`);
    return {
      boardName: meta.ok ? meta.data.name : null,
      jobs: (r.data.jobs || []).map(j => ({
        title: j.title || '',
        location: j.location?.name || '',
        url: j.absolute_url || `https://job-boards.greenhouse.io/${slug}/jobs/${j.id}`,
        external_id: String(j.id),
      })),
    };
  },
  async ashby(slug) {
    const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
    if (!r.ok) return null;
    const d = r.data;
    const list = Array.isArray(d) ? d : (d.jobs || d.results || d.jobPostings || d.postings || []);
    if (!Array.isArray(list)) return null;
    return {
      boardName: d.organization?.name || null,
      jobs: list.map(j => ({
        title: j.title || '',
        location: j.locationName || j.location?.name || (typeof j.location === 'string' ? j.location : '') || '',
        url: j.jobUrl || j.applyLink || `https://jobs.ashbyhq.com/${slug}/${j.id}`,
        external_id: String(j.id),
      })),
    };
  },
  async lever(slug) {
    const r = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=250`);
    if (!r.ok || !Array.isArray(r.data)) return null;
    return {
      boardName: r.data[0]?.company || null,
      jobs: r.data.map(j => ({
        title: j.text || '',
        location: j.categories?.location || j.workplaceType || '',
        url: j.hostedUrl,
        external_id: String(j.id),
      })),
    };
  },
  async workable(slug) {
    const r = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`);
    if (!r.ok || !r.data) return null;
    return {
      boardName: r.data.name || null,
      jobs: (r.data.jobs || []).map(j => ({
        title: j.title || '',
        location: [j.city, j.state, j.country].filter(Boolean).join(', ') || (j.telecommuting ? 'Remote' : ''),
        url: j.url || `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
        external_id: String(j.shortcode || j.id),
      })),
    };
  },
  async smartrecruiters(slug) {
    const r = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`);
    if (!r.ok || !r.data) return null;
    const list = r.data.content || [];
    if (!list.length) return null; // SR answers 200 with [] for unknown ids
    return {
      boardName: list[0]?.company?.name || null,
      jobs: list.map(p => ({
        title: p.name || '',
        location: [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(', '),
        url: `https://jobs.smartrecruiters.com/${slug}/${p.id}`,
        external_id: String(p.id),
      })),
    };
  },
};
const ATS_ORDER = ['greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters'];

// ── Board lookup per company ──────────────────────────────────────────────────

// Load the companies table once instead of once per company.
let COMPANY_INDEX = null;
async function loadCompanyIndex() {
  COMPANY_INDEX = new Map();
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from('companies')
      .select('ats_type, ats_slug, name').eq('active', true).in('ats_type', ATS_ORDER)
      .range(from, from + 999);
    if (error || !data || !data.length) break;
    for (const c of data) {
      for (const k of new Set([companyKey(c.ats_slug), companyKey(c.name)])) {
        if (!COMPANY_INDEX.has(k)) COMPANY_INDEX.set(k, []);
        COMPANY_INDEX.get(k).push(c);
      }
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  log(`📋 Loaded ${COMPANY_INDEX.size} company keys from the companies table`);
}

// Returns [{ ats_type, slug, boardName, jobs }] for every board we can read.
async function findBoards(company) {
  const boards = [];
  const tried = new Set();
  const key = companyKey(company);

  for (const c of COMPANY_INDEX.get(key) || []) {
    const id = `${c.ats_type}:${c.ats_slug}`;
    if (tried.has(id)) continue;
    tried.add(id);
    const b = await READERS[c.ats_type](c.ats_slug);
    if (b) boards.push({ ats_type: c.ats_type, slug: c.ats_slug, known: true, ...b });
  }
  if (boards.length) return boards;

  for (const slug of slugCandidates(company)) {
    for (const ats of ATS_ORDER) {
      const id = `${ats}:${slug}`;
      if (tried.has(id)) continue;
      tried.add(id);
      const b = await READERS[ats](slug);
      if (b && b.jobs.length) {
        // A slug can belong to a different company; when the board names itself,
        // require the names to be compatible.
        if (b.boardName) {
          const bn = companyKey(b.boardName);
          if (!(bn.includes(key) || key.includes(bn))) continue;
        }
        boards.push({ ats_type: ats, slug, known: false, ...b });
      }
      await sleep(80);
    }
    if (boards.length) break;
  }
  return boards;
}

// ── Matching ──────────────────────────────────────────────────────────────────

const GOOD_LOC_RE = /(san francisco|bay area|oakland|san jose|palo alto|mountain view|menlo park|sunnyvale|redwood city|santa clara|south san francisco|san mateo|berkeley|remote|anywhere|united states|\busa?\b)/i;

function pickBest(candidates, liLocation) {
  const liTokens = String(liLocation || '').toLowerCase().split(/[^a-z]+/).filter(t => t.length > 2 && !['united', 'states', 'remote'].includes(t));
  const scored = candidates.map(c => {
    let s = c.sim;
    const loc = c.job.location || '';
    if (GOOD_LOC_RE.test(loc)) s += 0.05;
    if (liTokens.length && liTokens.some(t => loc.toLowerCase().includes(t))) s += 0.05;
    return { ...c, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0];
}

function matchTitle(boards, row) {
  const candidates = [];
  for (const b of boards) {
    for (const job of b.jobs) {
      const sim = titleSimilarity(row.job_title, job.title);
      if (sim >= MIN_SIMILARITY) candidates.push({ board: b, job, sim });
    }
  }
  if (!candidates.length) return null;
  const best = pickBest(candidates, row.location);
  return { ...best, alternatives: candidates.length };
}

// ── Database writes ───────────────────────────────────────────────────────────

async function saveBoard(b, company) {
  if (DRY_RUN) return;
  await supabase.from('companies').upsert(
    [{ name: company, ats_type: b.ats_type, ats_slug: b.slug, active: true }],
    { onConflict: 'ats_slug', ignoreDuplicates: true }
  );
}

async function applyMatch(row, m) {
  const { board, job } = m;
  // Already stored under the direct link? Then this LinkedIn row is a duplicate.
  let dup = null;
  {
    const byUrl = await supabase.from('applications').select('id, status').eq('url', job.url).neq('id', row.id).limit(1);
    if (byUrl.data && byUrl.data.length) dup = byUrl.data;
    else {
      const byExt = await supabase.from('applications').select('id, status')
        .eq('ats_type', board.ats_type).eq('external_id', job.external_id).neq('id', row.id).limit(1);
      if (byExt.data && byExt.data.length) dup = byExt.data;
    }
  }
  const stamp = new Date().toISOString();

  if (dup && dup.length) {
    if (DRY_RUN) return { action: 'duplicate', of: dup[0].id };
    await supabase.from('applications').update({
      status: 'archived',
      link_status: 'resolved-duplicate',
      link_checked_at: stamp,
      notes: `${row.notes ? row.notes + ' | ' : ''}duplicate of #${dup[0].id} (found on ${board.ats_type}/${board.slug})`,
    }).eq('id', row.id);
    return { action: 'duplicate', of: dup[0].id };
  }

  if (DRY_RUN) return { action: 'resolve', url: job.url, location: job.location };
  const { error } = await supabase.from('applications').update({
    url: job.url,
    ats_type: board.ats_type,
    ats_slug: board.slug,
    external_id: job.external_id,
    location: job.location || row.location || null,
    link_status: 'live',
    link_checked_at: stamp,
    notes: `${row.notes ? row.notes + ' | ' : ''}resolved from LinkedIn #${row.linkedin_job_id || ''} via ${board.ats_type}/${board.slug}${m.alternatives > 1 ? ` (${m.alternatives} postings share this title)` : ''}`,
  }).eq('id', row.id);
  if (error) return { action: 'error', error: error.message };
  return { action: 'resolve', url: job.url, location: job.location };
}

async function markUnresolved(rows, why) {
  if (DRY_RUN || !rows.length) return;
  const stamp = new Date().toISOString();
  await supabase.from('applications').update({ link_status: 'unresolved', link_checked_at: stamp })
    .in('id', rows.map(r => r.id));
  log(`   ↳ marked ${rows.length} unresolved (${why})`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function loadRows() {
  const cutoff = new Date(Date.now() - 3 * 86400000).toISOString();
  const oldest = new Date(Date.now() - 45 * 86400000).toISOString();
  const { data, error } = await supabase.from('applications')
    .select('id, company, job_title, location, notes, linkedin_job_id, link_status, link_checked_at, created_at')
    .eq('source', 'linkedin')
    .in('status', ['queued', 'manual'])
    .ilike('url', '%linkedin.com%')
    .in('fit_tier', ['apply', 'review'])
    .gte('created_at', oldest)
    .or(`link_status.is.null,and(link_status.eq.unresolved,link_checked_at.lt.${cutoff})`)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw new Error(`loading rows failed: ${error.message}`);
  return data || [];
}

async function resolveCompany(company, rows, stats) {
  const boards = await findBoards(company);
  if (!boards.length) {
    stats.noBoard += rows.length;
    await markUnresolved(rows, 'no job board found');
    return;
  }
  for (const b of boards) await saveBoard(b, company);

  const noMatch = [];
  for (const row of rows) {
    const m = matchTitle(boards, row);
    if (!m) { noMatch.push(row); continue; }
    const r = await applyMatch(row, m);
    if (r.action === 'resolve') {
      stats.resolved++;
      log(`   ✅ ${company} — ${row.job_title} → ${r.url} (${r.location || 'no location'})`);
    } else if (r.action === 'duplicate') {
      stats.duplicates++;
      log(`   ♻ ${company} — ${row.job_title} duplicate of #${r.of}`);
    } else {
      stats.errors++;
      log(`   ❌ ${company} — ${row.job_title}: ${r.error}`);
    }
  }
  stats.noMatch += noMatch.length;
  await markUnresolved(noMatch, `board found (${boards.map(b => b.ats_type + '/' + b.slug).join(', ')}) but no posting with this title`);
}

async function main() {
  log(`🚀 LinkedIn resolver starting${DRY_RUN ? ' (DRY RUN: nothing will be written)' : ''}`);
  await loadCompanyIndex();
  const rows = await loadRows();
  log(`🔎 ${rows.length} unresolved LinkedIn rows`);
  if (!rows.length) { await logRun(supabase, 'resolve-linkedin', { found: 0 }); return; }

  const byCompany = new Map();
  for (const r of rows) {
    const k = companyKey(r.company);
    if (!k || k === 'unknown') continue;
    if (!byCompany.has(k)) byCompany.set(k, { company: r.company, rows: [] });
    byCompany.get(k).rows.push(r);
  }
  const groups = [...byCompany.values()];
  log(`🏢 ${groups.length} companies`);

  const stats = { resolved: 0, duplicates: 0, noBoard: 0, noMatch: 0, errors: 0 };
  let next = 0;
  async function worker() {
    while (next < groups.length) {
      const g = groups[next++];
      try { await resolveCompany(g.company, g.rows, stats); }
      catch (e) { stats.errors++; log(`   ❌ ${g.company}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  log(`\n📊 Resolved ${stats.resolved} · duplicates ${stats.duplicates} · no board ${stats.noBoard} · board but no matching title ${stats.noMatch} · errors ${stats.errors}`);
  await logRun(supabase, `resolve-linkedin${DRY_RUN ? ':dry' : ''}`, {
    found: rows.length, inserted: stats.resolved, archived: stats.duplicates, errors: stats.errors,
    notes: `no board ${stats.noBoard}, no title match ${stats.noMatch}`,
  });
}

if (require.main === module) {
  main().catch(async err => {
    log(`💥 Fatal: ${err.message}`);
    await logRun(supabase, 'resolve-linkedin', { errors: 1, notes: err.message });
    process.exit(1);
  });
}

module.exports = { slugCandidates, titleSimilarity, normTitle, matchTitle, pickBest };

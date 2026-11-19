/**
 * Shared web-search layer for the discovery scripts. Free credits only.
 *
 * Providers (each counted in Supabase `api_quota`; a call is refused once the
 * free limit minus a safety reserve is reached, see lib/quota.js):
 *   tavily      TAVILY_API_KEY                         1,000 free/month
 *   brightdata  BRIGHTDATA_API_KEY + BRIGHTDATA_ZONE   5,000 free/month
 *   serpapi     SERPAPI_KEY                            250 free/month (shared)
 *   serper      SERPER_API_KEY                         2,500 one-time credits
 *
 * mode 'merge': send each query to Tavily AND Bright Data, merge + de-duplicate;
 *               SerpApi / Serper only if both failed.
 * mode 'first': try providers in `order`, stop at the first that answers.
 *
 * search(text, domains) -> [{ title, link, snippet }] or null if nothing worked.
 * `domains` restricts results to those sites (include_domains / site: operators).
 */

const { spend } = require('./quota');

function createSearcher({ supabase, window = 'w', mode = 'merge', order, log = console.log, env = process.env }) {
  const W = ['d', 'w', 'm', 'y', 'a'].includes(window) ? window : 'w'; // a = any time
  const TBS = W === 'a' ? {} : { tbs: `qdr:${W}` };
  const siteClause = d => (d && d.length ? '(' + d.map(x => `site:${x}`).join(' OR ') + ') ' : '');

  async function tavily(text, domains) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: text,
        ...(domains && domains.length ? { include_domains: domains } : {}),
        ...(W === 'a' ? {} : { time_range: { d: 'day', w: 'week', m: 'month', y: 'year' }[W] }),
        search_depth: 'basic',
        max_results: 20,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 150)}`);
    const data = await res.json();
    return (data.results || []).map(r => ({ title: r.title, link: r.url, snippet: r.content }));
  }

  async function brightdata(text, domains) {
    // Real Google search, parsed (brd_json=1). 10 results per call.
    const url = `https://www.google.com/search?${new URLSearchParams({ q: siteClause(domains) + text, gl: 'us', hl: 'en', ...TBS, brd_json: '1' })}`;
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone: env.BRIGHTDATA_ZONE, url, format: 'raw' }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 150)}`);
    const body = await res.text();
    if (!body.trim()) throw new Error('empty response');
    const data = JSON.parse(body);
    return (data.organic || []).map(r => ({ title: r.title, link: r.link, snippet: r.description }));
  }

  async function serpapi(text, domains) {
    const params = new URLSearchParams({ engine: 'google', q: siteClause(domains) + text, num: '20', ...TBS, gl: 'us', hl: 'en', api_key: env.SERPAPI_KEY });
    const res = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error && !/hasn't returned any results/i.test(data.error)) throw new Error(data.error);
    return (data.organic_results || []).map(r => ({ title: r.title, link: r.link, snippet: r.snippet }));
  }

  async function serper(text, domains) {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: siteClause(domains) + text, num: 20, gl: 'us', hl: 'en', ...TBS }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.organic || []).map(r => ({ title: r.title, link: r.link, snippet: r.snippet }));
  }

  const ALL = [
    { name: 'tavily',     key: env.TAVILY_API_KEY,                           fn: tavily,     combine: true },
    { name: 'brightdata', key: env.BRIGHTDATA_API_KEY && env.BRIGHTDATA_ZONE, fn: brightdata, combine: true },
    { name: 'serpapi',    key: env.SERPAPI_KEY,                              fn: serpapi,    combine: false },
    { name: 'serper',     key: env.SERPER_API_KEY,                           fn: serper,     combine: false },
  ].filter(p => p.key);

  const used = {};
  const exhausted = new Set();

  async function call(p, text, domains) {
    if (exhausted.has(p.name)) return null;
    if (!(await spend(supabase, p.name))) {
      log(`  ⏭ ${p.name}: free budget used up`);
      exhausted.add(p.name);
      return null;
    }
    try {
      const r = await p.fn(text, domains);
      used[p.name] = (used[p.name] || 0) + 1;
      return r;
    } catch (e) {
      log(`  ⚠ ${p.name}: ${e.message}`);
      return null;
    }
  }

  const norm = u => String(u || '').replace(/^http:/, 'https:').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();

  async function search(text, domains) {
    if (mode === 'first') {
      const ordered = (order || ['brightdata', 'tavily', 'serpapi', 'serper'])
        .map(n => ALL.find(p => p.name === n)).filter(Boolean);
      for (const p of ordered) {
        const r = await call(p, text, domains);
        if (r !== null) return r;
      }
      return null;
    }
    const merged = [];
    const seen = new Set();
    let anyWorked = false;
    for (const p of ALL.filter(x => x.combine)) {
      const r = await call(p, text, domains);
      if (r === null) continue;
      anyWorked = true;
      for (const item of r) {
        const k = norm(item.link);
        if (k && !seen.has(k)) { seen.add(k); merged.push(item); }
      }
    }
    if (anyWorked) return merged;
    for (const p of ALL.filter(x => !x.combine)) {
      const r = await call(p, text, domains);
      if (r !== null) return r;
    }
    return null;
  }

  return { search, providers: ALL.map(p => p.name), used };
}

module.exports = { createSearcher };

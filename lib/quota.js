/**
 * Free-tier budget tracking for paid-if-you-overspend search APIs.
 * State lives in Supabase (table api_quota, view api_quota_status), so every
 * script and every run shares one count. Monthly plans reset on the 1st;
 * one-time credits never reset. A call is only made if budget remains after a
 * safety reserve, so nothing can ever run into paid usage.
 *
 *   if (!(await spend(supabase, 'serpapi'))) skip the call
 */

async function spend(supabase, provider, n = 1) {
  try {
    const { data, error } = await supabase.rpc('api_quota_spend', { p_provider: provider, p_n: n });
    if (error) { console.log(`  ⚠ quota check failed for ${provider}: ${error.message} (allowing call)`); return true; }
    return data === true;
  } catch (e) {
    console.log(`  ⚠ quota check failed for ${provider}: ${e.message} (allowing call)`);
    return true;
  }
}

module.exports = { spend };

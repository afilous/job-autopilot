/**
 * lib/runlog.js -- one row per discovery run in the run_log table.
 * Never throws: logging must not break a discovery run.
 */
async function logRun(supabase, script, stats = {}) {
  try {
    const { error } = await supabase.from('run_log').insert({
      script,
      finished_at: new Date().toISOString(),
      found: stats.found || 0,
      inserted: stats.inserted || 0,
      archived: stats.archived || 0,
      errors: stats.errors || 0,
      notes: stats.notes ? String(stats.notes).slice(0, 500) : null,
    });
    if (error) console.log(`  ⚠ run_log insert failed: ${error.message}`);
  } catch (e) {
    console.log(`  ⚠ run_log insert threw: ${e.message}`);
  }
}
module.exports = { logRun };

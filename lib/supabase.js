/**
 * lib/supabase.js — All Supabase database operations
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Recover stale processing jobs back to queued
async function recoverStaleJobs() {
  const staleWindow = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('applications')
    .update({ status: 'queued', notes: 'Auto-recovered from stale processing state' })
    .eq('status', 'processing')
    .lt('started_at', staleWindow);
  if (count > 0) log(`♻ Recovered ${count} stale jobs`);
}

// Fetch queued jobs ordered by score
// NOTE: the ats_type allow-list that used to sit here (only greenhouse/lever/
// ashby/workday) has been removed. It existed because the retired Playwright
// submitter only had handlers for those four ATSes. Tsenta supports 19+ ATSes
// and rejects unsupported ones per-job with a clean, non-fatal error via its
// own fetch-job-description preflight, so the allow-list was just silently
// dropping good jobs for no benefit.
// Also removed the generated_responses requirement -- Tsenta writes its own
// answers to free-text questions during resume optimization, so this is no
// longer a hard blocker for a job to be queue-eligible.
async function fetchQueuedJobs(limit, minScore, manualCompanies) {
  const { data, error } = await supabase
    .from('applications')
    .select('*')
    .eq('status', 'queued')
    .gte('match_score', minScore)
    .not('company', 'in', `(${manualCompanies.map(c => `"${c}"`).join(',')})`)
    .order('match_score', { ascending: false })
    .limit(limit);
  return { data, error };
}

// Fetch active resume
async function fetchActiveResume() {
  const { data } = await supabase
    .from('resumes').select('*').eq('is_active', true).limit(1).single();
  return data;
}

// Atomically claim a job for processing
async function claimJob(jobId) {
  const { data } = await supabase
    .from('applications')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId).eq('status', 'queued').select();
  return data && data.length > 0;
}

// Update job status
async function updateJobStatus(jobId, status, notes = null) {
  const update = { status };
  if (notes) update.notes = notes;
  if (status === 'submitted') update.submission_time = Math.floor(Date.now() / 1000);
  await supabase.from('applications').update(update).eq('id', jobId);
}

// Archive job
async function archiveJob(jobId, notes) {
  await supabase.from('applications').update({ status: 'archived', notes }).eq('id', jobId);
}

module.exports = { supabase, recoverStaleJobs, fetchQueuedJobs, fetchActiveResume, claimJob, updateJobStatus, archiveJob };

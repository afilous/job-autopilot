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
async function fetchQueuedJobs(limit, minScore, manualCompanies) {
  const { data, error } = await supabase
    .from('applications')
    .select('*')
    .eq('status', 'queued')
    .not('generated_responses', 'is', null)
    .in('ats_type', ['greenhouse', 'lever', 'ashby', 'workday'])
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

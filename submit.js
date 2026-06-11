/**
 * Job Autopilot — Main Orchestrator
 * 
 * Architecture:
 *   lib/profile.js    — candidate data, answer helpers
 *   lib/browser.js    — stealth launch, session warming, context
 *   lib/captcha.js    — CapSolver CAPTCHA solving
 *   lib/resume.js     — PDF download, cache, upload
 *   lib/supabase.js   — all DB operations
 *   lib/helpers.js    — shared page interaction utilities
 *   lib/gmail.js      — Gmail OAuth for Greenhouse security codes
 *   ats/greenhouse.js — Greenhouse handler
 *   ats/lever.js      — Lever handler
 *   ats/ashby.js      — Ashby handler
 *   ats/workday.js    — Workday handler (skeleton)
 */

const { launchStealthBrowser, createContext, createPage, warmUpSession } = require('./lib/browser');
const { recoverStaleJobs, fetchQueuedJobs, fetchActiveResume, claimJob, updateJobStatus, archiveJob } = require('./lib/supabase');
const { ensureResumeCached } = require('./lib/resume');
const { submitGreenhouse } = require('./ats/greenhouse');
const { submitLever } = require('./ats/lever');
const { submitAshby } = require('./ats/ashby');
const { submitWorkday } = require('./ats/workday');

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SUBMISSIONS = parseInt(process.env.MAX_SUBMISSIONS || '20');
const MIN_SCORE = parseInt(process.env.MIN_SCORE || '75');
const DELAY_BETWEEN_MS = () => 12000 + Math.random() * 8000;

const MANUAL_COMPANIES = ['Stripe', 'Databricks', 'Block', 'Intuit', 'Waymo'];

// Known Lever CAPTCHA offenders — archive instead of manual
const LEVER_CAPTCHA_COMPANIES = ['cfgi','zoox','shieldai','moloco','anchorage','canary','anaplan','affirm'];

const TITLE_BLACKLIST = [
  'security operations','incident response',' soc ','v-bat','air vehicle','drone operator',
  'software engineer','backend engineer','frontend engineer','devops','data scientist',
  'machine learning engineer','legal counsel','attorney','accountant','debt collection',
  'collections specialist','field technician','hardware engineer','network engineer',
  'technical program manager',
];

const runLog = { started_at: new Date().toISOString(), dry_run: DRY_RUN, results: [] };

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  log(DRY_RUN ? '🔍 DRY RUN mode' : '🚀 Starting job submission run');
  log(`📊 Max submissions: ${MAX_SUBMISSIONS} | Min score: ${MIN_SCORE}%`);

  await recoverStaleJobs();

  const { data: jobs, error } = await fetchQueuedJobs(MAX_SUBMISSIONS, MIN_SCORE, MANUAL_COMPANIES);
  if (error) { log(`❌ Failed to fetch jobs: ${error.message}`); process.exit(1); }
  if (!jobs || jobs.length === 0) { log('✅ No jobs queued'); saveLog(); return; }
  log(`📋 Found ${jobs.length} jobs`);

  const resumeData = await fetchActiveResume();
  const resumeText = resumeData?.raw_text || '';
  const resumePdfUrl = resumeData?.pdf_url || null;
  log(`📄 Resume: ${resumeData?.filename || 'none'}`);

  // Pre-cache resume once for entire run
  if (resumePdfUrl) await ensureResumeCached(resumePdfUrl);

  const { browser, proxyUrl } = await launchStealthBrowser();

  // ── Persistent context — shared across ALL jobs in this run ──────────────
  // Accumulates cookies and session data, looks more human to bot detectors
  const context = await createContext(browser, proxyUrl);
  const warmPage = await createPage(context);

  // Warm up session before hitting any ATS portals
  await warmUpSession(warmPage);
  await warmPage.close();
  // ─────────────────────────────────────────────────────────────────────────

  let submitted = 0, failed = 0, manual = 0, skipped = 0, duplicate = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];

    // Title blacklist filter
    const titleLower = (job.job_title || '').toLowerCase();
    if (TITLE_BLACKLIST.some(t => titleLower.includes(t))) {
      try { await archiveJob(job.id, 'Irrelevant role type'); } catch(e) {}
      log(`  ⏭ Archived irrelevant: ${job.job_title}`);
      continue;
    }

    log(`\n[${i+1}/${jobs.length}] ${job.job_title} at ${job.company} (${job.ats_type})`);
    log(`  Score: ${job.match_score}% | Variant: ${job.resume_variant || 'default'}`);

    // Pre-flight URL check
    try {
      const check = await fetch(job.url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if ([404, 410].includes(check.status)) {
        log(`  ⚰ Job gone (${check.status})`);
        await archiveJob(job.id, `HTTP ${check.status}`);
        skipped++; continue;
      }
      if ([301, 302].includes(check.status) && job.ats_type === 'lever') {
        const loc = check.headers.get('location') || '';
        if (!loc.includes(job.external_id)) {
          log(`  ⚰ Lever redirected away`);
          await archiveJob(job.id, 'Lever 302 redirect');
          skipped++; continue;
        }
      }
    } catch(e) { log(`  ⚠ Pre-flight: ${e.message}`); }

    if (DRY_RUN) {
      log('  ⏭ DRY RUN');
      runLog.results.push({ job_id: job.id, status: 'dry_run' });
      skipped++; continue;
    }

    // Atomically claim job
    const claimed = await claimJob(job.id);
    if (!claimed) { log(`  ⏭ Already claimed`); skipped++; continue; }

    // Create new page within persistent context (reuses session cookies)
    const page = await createPage(context);

    try {
      let result;

      if (job.ats_type === 'greenhouse') result = await submitGreenhouse(page, job, resumeText, resumePdfUrl);
      else if (job.ats_type === 'lever') result = await submitLever(page, job, resumeText, resumePdfUrl);
      else if (job.ats_type === 'ashby') result = await submitAshby(page, job, resumeText, resumePdfUrl);
      else if (job.ats_type === 'workday') result = await submitWorkday(page, job, resumeText, resumePdfUrl);
      else result = { success: false, manual: true, message: `Unknown ATS: ${job.ats_type}` };

      // Handle result
      if (result.duplicate) {
        await updateJobStatus(job.id, 'duplicate', result.message);
        log(`  ♻ ${result.message}`); duplicate++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'duplicate' });

      } else if (result.manual) {
        const companyLower = (job.company || '').toLowerCase();
        // Archive known Lever CAPTCHA companies instead of marking manual
        if (job.ats_type === 'lever' && LEVER_CAPTCHA_COMPANIES.some(c => companyLower.includes(c))) {
          await archiveJob(job.id, 'Lever hCaptcha — known blocker');
          log(`  🗄 Archived Lever CAPTCHA: ${job.company}`);
        } else {
          await updateJobStatus(job.id, 'manual', result.message);
          log(`  📋 Manual: ${result.message}`);
        }
        manual++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'manual' });

      } else if (result.success) {
        await updateJobStatus(job.id, 'submitted', result.message);
        log(`  ✅ ${result.message}`); submitted++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'submitted' });

      } else {
        await updateJobStatus(job.id, 'failed', result.message);
        log(`  ❌ ${result.message}`); failed++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'failed', message: result.message });
      }

    } catch(err) {
      log(`  💥 Exception: ${err.message}`);
      await page.screenshot({ path: `/tmp/error-${job.id}.png`, fullPage: true }).catch(() => {});
      await updateJobStatus(job.id, 'failed', `Exception: ${err.message}`);
      failed++;
    } finally {
      await page.close();
    }

    if (i < jobs.length - 1) {
      const delay = Math.floor(DELAY_BETWEEN_MS());
      log(`  ⏳ Waiting ${Math.round(delay/1000)}s...`);
      await sleep(delay);
    }
  }

  await context.close();
  await browser.close();

  log(`\n────────────────────────────────`);
  log(`✅ Submitted:  ${submitted}`);
  log(`♻ Duplicate:  ${duplicate}`);
  log(`❌ Failed:     ${failed}`);
  log(`📋 Manual:     ${manual}`);
  log(`⏭ Skipped:    ${skipped}`);

  runLog.completed_at = new Date().toISOString();
  runLog.summary = { submitted, duplicate, failed, manual, skipped };
  saveLog();
}

function saveLog() {
  const fs = require('fs');
  fs.writeFileSync(`/tmp/submission-log-${Date.now()}.json`, JSON.stringify(runLog, null, 2));
  log(`\n📝 Run log saved`);
}

main().catch(err => {
  log(`💥 Fatal: ${err.message}`);
  runLog.error = err.message;
  saveLog();
  process.exit(1);
});

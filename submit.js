/**
 * Job Autopilot — Automated Application Submission
 * Reads queued jobs from Supabase, submits via Playwright, updates status
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SUBMISSIONS = 10;
const DELAY_BETWEEN_MS = 12000 + Math.random() * 8000;

const PROFILE = {
  full_name: 'Aaron Filous',
  first_name: 'Aaron',
  last_name: 'Filous',
  email: 'filousaaron@gmail.com',
  phone: '6502913142',
  phone_formatted: '(650) 291-3142',
  linkedin: 'https://www.linkedin.com/in/aaron-filous/',
  location: 'San Mateo, CA',
  city: 'San Mateo',
  state: 'CA',
  zip: '94401',
  country: 'United States',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const runLog = {
  started_at: new Date().toISOString(),
  dry_run: DRY_RUN,
  results: [],
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log(DRY_RUN ? '🔍 DRY RUN mode' : '🚀 Starting job submission run');

  const { data: jobs, error } = await supabase
    .from('applications')
    .select('*')
    .eq('status', 'queued')
    .not('generated_responses', 'is', null)
    .in('ats_type', ['greenhouse', 'lever', 'ashby'])
    .order('match_score', { ascending: false })
    .limit(MAX_SUBMISSIONS);

  if (error) { log(`❌ Failed to fetch jobs: ${error.message}`); process.exit(1); }
  if (!jobs || jobs.length === 0) { log('✅ No jobs queued — nothing to submit'); saveLog(); return; }

  log(`📋 Found ${jobs.length} jobs to submit`);

  const { data: resumeData } = await supabase
    .from('resumes').select('*').eq('is_active', true).limit(1).single();

  const resumeText = resumeData?.raw_text || '';
  const resumePdfUrl = resumeData?.pdf_url || null;
  log(`📄 Resume: ${resumeData?.filename || 'default'}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let submitted = 0, failed = 0, manual = 0, skipped = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    log(`\n[${i + 1}/${jobs.length}] ${job.job_title} at ${job.company} (${job.ats_type})`);
    log(`  URL: ${job.url}`);
    log(`  Score: ${job.match_score}%`);

    if (DRY_RUN) {
      log('  ⏭ DRY RUN — skipping');
      runLog.results.push({ job_id: job.id, job_title: job.job_title, company: job.company, status: 'dry_run' });
      skipped++;
      continue;
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    try {
      let result;

      if (job.ats_type === 'greenhouse') {
        result = await submitGreenhouse(page, job, resumeText, resumePdfUrl);
      } else if (job.ats_type === 'lever') {
        result = await submitLever(page, job, resumeText, resumePdfUrl);
      } else if (job.ats_type === 'ashby') {
        result = await submitAshby(page, job, resumeText, resumePdfUrl);
      }

      if (result.manual) {
        await supabase.from('applications').update({
          status: 'manual',
          notes: result.message,
        }).eq('id', job.id);
        log(`  → Marked for manual apply: ${result.message}`);
        manual++;
        runLog.results.push({ job_id: job.id, job_title: job.job_title, company: job.company, status: 'manual', message: result.message });
      } else if (result.success) {
        await supabase.from('applications').update({
          status: 'submitted',
          submission_time: Math.floor(Date.now() / 1000),
          notes: result.message,
        }).eq('id', job.id);
        log(`  ✅ ${result.message}`);
        submitted++;
        runLog.results.push({ job_id: job.id, job_title: job.job_title, company: job.company, status: 'submitted', message: result.message });
      } else {
        await supabase.from('applications').update({
          status: 'failed',
          notes: result.message,
        }).eq('id', job.id);
        log(`  ❌ ${result.message}`);
        failed++;
        runLog.results.push({ job_id: job.id, job_title: job.job_title, company: job.company, status: 'failed', message: result.message });
      }

    } catch (err) {
      log(`  💥 Exception: ${err.message}`);
      await supabase.from('applications').update({
        status: 'failed',
        notes: `Exception: ${err.message}`,
      }).eq('id', job.id);
      failed++;
      runLog.results.push({ job_id: job.id, job_title: job.job_title, company: job.company, status: 'error', message: err.message });
    } finally {
      await context.close();
    }

    if (i < jobs.length - 1) {
      const delay = Math.floor(DELAY_BETWEEN_MS);
      log(`  ⏳ Waiting ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
    }
  }

  await browser.close();

  log(`\n────────────────────────────────`);
  log(`✅ Submitted: ${submitted}`);
  log(`❌ Failed: ${failed}`);
  log(`📋 Manual: ${manual}`);
  log(`⏭ Skipped: ${skipped}`);

  runLog.completed_at = new Date().toISOString();
  runLog.summary = { submitted, failed, manual, skipped };
  saveLog();
}

// ── Greenhouse ────────────────────────────────────────────────────────────────
async function submitGreenhouse(page, job, resumeText, resumePdfUrl) {
  try {
    // Build direct application form URL
    const baseUrl = job.url
      .replace('boards.greenhouse.io', 'job-boards.greenhouse.io')
      .replace(/\/$/, '');
    const applyUrl = `${baseUrl}/applications/new`;

    log(`  🌐 Navigating to: ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Detect redirect to custom domain (Stripe, Databricks etc)
    const finalUrl = page.url();
    const finalDomain = new URL(finalUrl).hostname;
    if (!finalDomain.includes('greenhouse.io')) {
      log(`  ↪ Redirected to custom site: ${finalDomain}`);
      return { success: false, manual: true, message: `Custom career site: ${finalDomain} — apply manually` };
    }

    log(`  📍 On page: ${finalUrl}`);

    // Check if application form exists
    const formExists = await page.$('#application-form, form[action*="application"], .application-form, #application, form#application_form');
    if (!formExists) {
      log(`  ⚠ No form found — page title: ${await page.title()}`);
      return { success: false, message: `No application form found at ${finalUrl}` };
    }

    log(`  ✓ Form found — filling fields`);
    const answers = job.generated_responses || {};

    // Fill basic fields
    await fillField(page, '#first_name, [name="job_application[first_name]"]', PROFILE.first_name);
    await fillField(page, '#last_name, [name="job_application[last_name]"]', PROFILE.last_name);
    await fillField(page, '#email, [name="job_application[email]"]', PROFILE.email);
    await fillField(page, '#phone, [name="job_application[phone]"]', PROFILE.phone_formatted);
    await fillField(page, '#resume_text, [name="job_application[resume_text]"]', resumeText);

    // LinkedIn
    const linkedinField = await page.$('[name*="linkedin"], [id*="linkedin"], [placeholder*="linkedin" i]');
    if (linkedinField) await linkedinField.fill(PROFILE.linkedin);

    // Location
    await fillField(page, '#location, [name*="location"]', PROFILE.location);

    // AI generated answers
    if (answers && typeof answers === 'object') {
      for (const [question, answer] of Object.entries(answers)) {
        await tryFillByLabel(page, question, String(answer));
      }
    }

    // Work authorization dropdowns
    await handleDropdownByLabel(page, /authorized.*work|work.*authorized/i, 'Yes');
    await handleDropdownByLabel(page, /sponsorship|visa/i, 'No');

    // Resume PDF upload
    if (resumePdfUrl) {
      await uploadResumePdf(page, resumePdfUrl, '[name="job_application[resume]"], input[type="file"][accept*="pdf"], input[type="file"]');
    }

    // Submit
    const submitBtn = await page.$('#submit_app, [value="Submit Application"], button[type="submit"], input[type="submit"]');
    if (!submitBtn) {
      return { success: false, message: 'Submit button not found' };
    }
    await submitBtn.click();
    await page.waitForTimeout(4000);

    // Check result
    const finalPageUrl = page.url();
    const pageTitle = await page.title();
    const pageText = await page.textContent('body');
    log(`  📍 After submit: ${finalPageUrl}`);
    log(`  📍 Title: ${pageTitle}`);
    log(`  📍 Text: ${pageText.slice(0, 200)}`);

    if (pageText.match(/thank you|application received|submitted|we.ll be in touch|confirmation/i)) {
      return { success: true, message: 'Submitted via Greenhouse form ✓' };
    }

    if (pageText.match(/error|required|invalid|please fill|can.t be blank/i)) {
      return { success: false, message: `Form validation error — check required fields` };
    }

    // URL changed = likely success
    if (finalPageUrl !== applyUrl) {
      return { success: true, message: `Submitted — redirected to ${finalPageUrl}` };
    }

    return { success: false, message: `Submitted but no confirmation detected — title: ${pageTitle}` };

  } catch (err) {
    return { success: false, message: `Greenhouse error: ${err.message}` };
  }
}

// ── Lever ─────────────────────────────────────────────────────────────────────
async function submitLever(page, job, resumeText, resumePdfUrl) {
  try {
    const applyUrl = job.url.includes('/apply') ? job.url : `${job.url}/apply`;
    log(`  🌐 Navigating to: ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Detect redirect away from Lever
    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('lever.co')) {
      return { success: false, manual: true, message: `Custom career site: ${finalDomain} — apply manually` };
    }

    const answers = job.generated_responses || {};

    await fillField(page, '[name="name"], #name', PROFILE.full_name);
    await fillField(page, '[name="email"], #email', PROFILE.email);
    await fillField(page, '[name="phone"], #phone', PROFILE.phone_formatted);

    const linkedinField = await page.$('[name*="linkedin"], [placeholder*="linkedin" i]');
    if (linkedinField) await linkedinField.fill(PROFILE.linkedin);

    const resumeField = await page.$('textarea[name="resume"], #resume-text');
    if (resumeField) await resumeField.fill(resumeText);

    if (resumePdfUrl) {
      await uploadResumePdf(page, resumePdfUrl, 'input[type="file"]');
    }

    if (answers && typeof answers === 'object') {
      for (const [question, answer] of Object.entries(answers)) {
        await tryFillByLabel(page, question, String(answer));
      }
    }

    await page.click('[type="submit"], .lever-button-black, button[data-qa="btn-submit"]');
    await page.waitForTimeout(3000);

    const pageText = await page.textContent('body');
    log(`  📍 After submit: ${page.url()}`);
    log(`  📍 Text: ${pageText.slice(0, 200)}`);

    if (pageText.match(/thank you|application received|submitted/i)) {
      return { success: true, message: 'Submitted via Lever form ✓' };
    }

    return { success: false, message: `Lever submitted but no confirmation — ${page.url()}` };

  } catch (err) {
    return { success: false, message: `Lever error: ${err.message}` };
  }
}

// ── Ashby ─────────────────────────────────────────────────────────────────────
async function submitAshby(page, job, resumeText, resumePdfUrl) {
  try {
    const applyUrl = job.url.includes('/application') ? job.url : `${job.url}/application`;
    log(`  🌐 Navigating to: ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Detect redirect away from Ashby
    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('ashbyhq.com')) {
      return { success: false, manual: true, message: `Custom career site: ${finalDomain} — apply manually` };
    }

    const answers = job.generated_responses || {};

    await fillField(page, '[name*="firstName"], [placeholder*="First name" i]', PROFILE.first_name);
    await fillField(page, '[name*="lastName"], [placeholder*="Last name" i]', PROFILE.last_name);
    await fillField(page, '[name*="email"], [type="email"]', PROFILE.email);
    await fillField(page, '[name*="phone"], [type="tel"]', PROFILE.phone_formatted);

    const linkedinField = await page.$('[name*="linkedin"], [placeholder*="linkedin" i]');
    if (linkedinField) await linkedinField.fill(PROFILE.linkedin);

    if (resumePdfUrl) {
      await uploadResumePdf(page, resumePdfUrl, 'input[type="file"]');
    }

    if (answers && typeof answers === 'object') {
      for (const [question, answer] of Object.entries(answers)) {
        await tryFillByLabel(page, question, String(answer));
      }
    }

    await page.click('[type="submit"], button:has-text("Submit"), button:has-text("Apply")');
    await page.waitForTimeout(3000);

    const pageText = await page.textContent('body');
    log(`  📍 After submit: ${page.url()}`);
    log(`  📍 Text: ${pageText.slice(0, 200)}`);

    if (pageText.match(/thank you|application received|submitted|success/i)) {
      return { success: true, message: 'Submitted via Ashby form ✓' };
    }

    return { success: false, message: `Ashby submitted but no confirmation — ${page.url()}` };

  } catch (err) {
    return { success: false, message: `Ashby error: ${err.message}` };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fillField(page, selector, value) {
  if (!value) return false;
  try {
    const el = await page.$(selector);
    if (el) { await el.fill(value); return true; }
  } catch (e) {}
  return false;
}

async function tryFillByLabel(page, labelText, value) {
  if (!value || !labelText) return false;
  try {
    const labels = await page.$$('label');
    for (const label of labels) {
      const text = await label.textContent();
      if (text && text.toLowerCase().includes(labelText.toLowerCase().slice(0, 30))) {
        const forAttr = await label.getAttribute('for');
        if (forAttr) {
          const input = await page.$(`#${forAttr}, [name="${forAttr}"]`);
          if (input) {
            const tagName = await input.evaluate(el => el.tagName.toLowerCase());
            const inputType = await input.evaluate(el => el.type || '');
            if (tagName === 'textarea' || (tagName === 'input' && !['radio', 'checkbox', 'file'].includes(inputType))) {
              await input.fill(value);
              return true;
            }
          }
        }
      }
    }
  } catch (e) {}
  return false;
}

async function handleDropdownByLabel(page, labelRegex, value) {
  try {
    const selects = await page.$$('select');
    for (const select of selects) {
      const id = await select.getAttribute('id');
      const label = await page.$(`label[for="${id}"]`);
      const labelText = label ? await label.textContent() : '';
      if (labelRegex.test(labelText)) {
        await select.selectOption({ label: value });
        return true;
      }
    }
  } catch (e) {}
  return false;
}

async function uploadResumePdf(page, pdfUrl, selector) {
  try {
    const fileInput = await page.$(selector);
    if (!fileInput) return false;
    const response = await fetch(pdfUrl);
    if (!response.ok) return false;
    const buffer = await response.arrayBuffer();
    const tmpPath = `/tmp/resume_${Date.now()}.pdf`;
    fs.writeFileSync(tmpPath, Buffer.from(buffer));
    await fileInput.setInputFiles(tmpPath);
    fs.unlinkSync(tmpPath);
    log(`  📎 Resume uploaded`);
    return true;
  } catch (e) {
    log(`  ⚠ Resume upload failed: ${e.message}`);
    return false;
  }
}

function saveLog() {
  fs.writeFileSync('run-log.json', JSON.stringify(runLog, null, 2));
  log(`\n📝 Run log saved to run-log.json`);
}

main().catch(err => {
  log(`💥 Fatal error: ${err.message}`);
  runLog.error = err.message;
  saveLog();
  process.exit(1);
});

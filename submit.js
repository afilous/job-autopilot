/**
 * Job Autopilot — Automated Application Submission
 * Incorporates all Gemini insights and confirmed ATS mechanics
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PROXY_URL = process.env.PROXY_URL || null;
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SUBMISSIONS = 10;
const MIN_SCORE = 75;
const DELAY_BETWEEN_MS = () => 12000 + Math.random() * 8000;

// Resume variants — add more URLs to Supabase storage as they become available
// Gemini scorer sets resume_variant column; we pick the right PDF here
const RESUME_VARIANTS = {
  fintech: null,       // future: 'https://...supabase.../resume_fintech.pdf'
  early_stage: null,  // future: 'https://...supabase.../resume_early_stage.pdf'
  default: null,      // loaded from Supabase resumes table at runtime
};

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
  website: 'https://www.linkedin.com/in/aaron-filous/',
  heard_about: 'LinkedIn',
  authorized_to_work: 'Yes',
  requires_sponsorship: 'No',
  salary_expectation: '145000',
};

// Dynamic answer focus rotation — keeps AI answers feeling fresh
const FOCUS_ELEMENTS = [
  'Quantitative scale metrics',
  'Cross-functional team execution',
  'Operational framework construction',
  'Revenue efficiency',
];

// Companies that use custom career sites — skip automation
const MANUAL_COMPANIES = ['Stripe', 'Databricks', 'Block', 'Intuit', 'Waymo'];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const runLog = { started_at: new Date().toISOString(), dry_run: DRY_RUN, results: [] };

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomFocus() { return FOCUS_ELEMENTS[Math.floor(Math.random() * FOCUS_ELEMENTS.length)]; }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log(DRY_RUN ? '🔍 DRY RUN mode' : '🚀 Starting job submission run');

  // Fetch queued jobs
  const { data: jobs, error } = await supabase
    .from('applications')
    .select('*')
    .eq('status', 'queued')
    .not('generated_responses', 'is', null)
    .in('ats_type', ['greenhouse', 'lever', 'ashby'])
    .gte('match_score', MIN_SCORE)
    .not('company', 'in', `(${MANUAL_COMPANIES.map(c => `"${c}"`).join(',')})`)
    .order('match_score', { ascending: false })
    .limit(MAX_SUBMISSIONS);

  if (error) { log(`❌ Failed to fetch jobs: ${error.message}`); process.exit(1); }
  if (!jobs || jobs.length === 0) { log('✅ No jobs queued — nothing to submit'); saveLog(); return; }

  log(`📋 Found ${jobs.length} jobs to submit (min score: ${MIN_SCORE}%)`);

  // Load active resume
  const { data: resumeData } = await supabase
    .from('resumes').select('*').eq('is_active', true).limit(1).single();

  const resumeText = resumeData?.raw_text || '';
  RESUME_VARIANTS.default = resumeData?.pdf_url || null;
  log(`📄 Resume: ${resumeData?.filename || 'default'}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-infobars',
    ],
  });

  let submitted = 0, failed = 0, manual = 0, skipped = 0, duplicate = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    log(`\n[${i + 1}/${jobs.length}] ${job.job_title} at ${job.company} (${job.ats_type})`);
    log(`  Score: ${job.match_score}% | Variant: ${job.resume_variant || 'default'}`);

    // Pre-flight HEAD check — skip dead URLs before spinning up browser
    try {
      const check = await fetch(job.url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      if ([404, 410].includes(check.status)) {
        log(`  ⚰ Job gone (${check.status}) — archiving`);
        await supabase.from('applications').update({ status: 'archived', notes: `HTTP ${check.status}` }).eq('id', job.id);
        skipped++;
        continue;
      }
      // Lever returns 302 for dead jobs — check if redirecting to parent slug (no job ID in redirect)
      if ([301, 302].includes(check.status) && job.ats_type === 'lever') {
        const loc = check.headers.get('location') || '';
        if (!loc.includes(job.external_id)) {
          log(`  ⚰ Lever job redirected away — archiving`);
          await supabase.from('applications').update({ status: 'archived', notes: 'Lever 302 redirect' }).eq('id', job.id);
          skipped++;
          continue;
        }
      }
    } catch (e) {
      log(`  ⚠ Pre-flight failed: ${e.message} — continuing`);
    }

    if (DRY_RUN) {
      log('  ⏭ DRY RUN — skipping');
      runLog.results.push({ job_id: job.id, status: 'dry_run' });
      skipped++;
      continue;
    }

    // Idempotency guard — atomically claim the record
    const { data: claimed } = await supabase
      .from('applications')
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select();

    if (!claimed || claimed.length === 0) {
      log(`  ⏭ Already claimed by another run — skipping`);
      skipped++;
      continue;
    }

    // Pick resume variant
    const variantKey = job.resume_variant || 'default';
    const resumePdfUrl = RESUME_VARIANTS[variantKey] || RESUME_VARIANTS.default;

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      hasTouch: false,
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      ...(PROXY_URL ? { proxy: { server: PROXY_URL } } : {}),
    });

    const page = await context.newPage();

    // Full Mac Chrome spoofing
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    // Wire browser console errors to our logs
    page.on('console', msg => { if (msg.type() === 'error') log(`  🖥 ${msg.text()}`); });
    page.on('pageerror', err => log(`  🖥 JS error: ${err.message}`));

    try {
      let result;
      const focus = randomFocus();
      log(`  🎯 Answer focus: ${focus}`);

      if (job.ats_type === 'greenhouse') {
        result = await submitGreenhouse(page, job, resumeText, resumePdfUrl, focus);
      } else if (job.ats_type === 'lever') {
        result = await submitLever(page, job, resumeText, resumePdfUrl, focus);
      } else if (job.ats_type === 'ashby') {
        result = await submitAshby(page, job, resumeText, resumePdfUrl, focus);
      }

      if (result.duplicate) {
        await supabase.from('applications').update({ status: 'duplicate', notes: result.message }).eq('id', job.id);
        log(`  ♻ ${result.message}`);
        duplicate++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'duplicate' });
      } else if (result.manual) {
        await supabase.from('applications').update({ status: 'manual', notes: result.message }).eq('id', job.id);
        log(`  📋 Manual: ${result.message}`);
        manual++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'manual' });
      } else if (result.success) {
        await supabase.from('applications').update({
          status: 'submitted',
          submission_time: Math.floor(Date.now() / 1000),
          notes: result.message,
        }).eq('id', job.id);
        log(`  ✅ ${result.message}`);
        submitted++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'submitted' });
      } else {
        await supabase.from('applications').update({ status: 'failed', notes: result.message }).eq('id', job.id);
        log(`  ❌ ${result.message}`);
        failed++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'failed', message: result.message });
      }

    } catch (err) {
      log(`  💥 Exception: ${err.message}`);
      await page.screenshot({ path: `/tmp/error-${job.id}.png`, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      if (html) fs.writeFileSync(`/tmp/error-${job.id}.html`, html.slice(0, 50000));
      await supabase.from('applications').update({ status: 'failed', notes: `Exception: ${err.message}` }).eq('id', job.id);
      failed++;
    } finally {
      await context.close();
    }

    if (i < jobs.length - 1) {
      const delay = Math.floor(DELAY_BETWEEN_MS());
      log(`  ⏳ Waiting ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
    }
  }

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

// ── Greenhouse ────────────────────────────────────────────────────────────────
async function submitGreenhouse(page, job, resumeText, resumePdfUrl, focus) {
  try {
    const jobId = job.external_id;
    const slug = job.ats_slug;
    const applyUrl = `https://boards.greenhouse.io/${slug}/jobs/${jobId}?gh_jid=${jobId}#app`;

    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const finalDomain = new URL(finalUrl).hostname;
    if (!finalDomain.includes('greenhouse.io')) {
      return { success: false, manual: true, message: `Custom site: ${finalDomain}` };
    }

    // Check form exists
    const formExists = await page.$('form, #application-form, .application-form');
    if (!formExists) {
      const html = await page.content();
      fs.writeFileSync('/tmp/greenhouse-debug.html', html.slice(0, 50000));
      return { success: false, message: `No form found at ${finalUrl}` };
    }

    // Standard fields with human typing
    await humanType(page, '#first_name', PROFILE.first_name);
    await humanType(page, '#last_name', PROFILE.last_name);
    await humanType(page, '#email', PROFILE.email);
    await humanType(page, '#phone', PROFILE.phone_formatted);
    await humanType(page, '#job_application_location', PROFILE.city);

    // LinkedIn
    for (const sel of ['input[name*="linkedin" i]', 'input[id*="linkedin" i]', 'input[placeholder*="linkedin" i]']) {
      if (await humanType(page, sel, PROFILE.linkedin)) break;
    }

    // Website
    for (const sel of ['input[name*="website" i]', 'input[id*="website" i]']) {
      if (await humanType(page, sel, PROFILE.website)) break;
    }

    // Upload resume PDF
    if (resumePdfUrl) {
      const uploaded = await uploadResumePdf(page, resumePdfUrl, [
        'input[type="file"][id="resume_file"]',
        'input[type="file"][name="job_application[resume]"]',
        'input[type="file"][accept*="pdf"]',
        'input[type="file"]',
      ]);
      if (uploaded) log(`  📎 Resume uploaded`);
    }

    // Resume text fallback
    await fillField(page, ['#resume_text', 'textarea[name="job_application[resume_text]"]'], resumeText.slice(0, 5000));

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));

    // Work authorization radio buttons
    await handleRadioByText(page, /authorized.*work|work.*authorized|eligible.*work/i, /^Yes$/i);
    await handleRadioByText(page, /require.*sponsorship|visa sponsor|need.*sponsor/i, /^No$/i);

    // Work authorization dropdowns
    await handleDropdownByText(page, /authorized.*work|work.*authorized/i, 'Yes');
    await handleDropdownByText(page, /require.*sponsorship|visa/i, 'No');

    // How did you hear
    try {
      const heardSel = await page.$('select[name*="referral" i], select[id*="heard" i]');
      if (heardSel) await heardSel.selectOption({ label: 'LinkedIn' }).catch(() => {});
    } catch (e) {}

    // Custom questions via div.field pattern
    const customFields = await page.$$('div.field');
    for (const field of customFields) {
      try {
        const label = await field.$('label');
        if (!label) continue;
        const questionText = await label.innerText();

        const inputEl = await field.$('input[type="text"], input[type="url"], textarea');
        if (!inputEl) continue;

        const inputId = await inputEl.getAttribute('id') || '';
        if (['first_name', 'last_name', 'email', 'phone', 'job_application_location'].includes(inputId)) continue;

        // Match against AI-generated answers
        const answers = job.generated_responses || {};
        let answer = null;
        for (const [q, a] of Object.entries(answers)) {
          if (questionText.toLowerCase().includes(q.toLowerCase().slice(0, 25))) {
            answer = String(a);
            break;
          }
        }

        if (answer) {
          await inputEl.focus();
          await inputEl.fill('');
          for (const char of answer.slice(0, 500)) {
            await page.keyboard.type(char);
            await page.waitForTimeout(Math.floor(Math.random() * 30 + 8));
          }
          await page.waitForTimeout(300);
          log(`  ✓ Custom field: ${questionText.slice(0, 50)}`);
        }
      } catch (e) {}
    }

    // Submit button — scroll → hover → humanized click
    const submitBtn = page.locator('#submit_app, input[type="submit"][value*="Submit" i], button[type="submit"]').first();
    if (await submitBtn.count() === 0) {
      const html = await page.content();
      fs.writeFileSync('/tmp/greenhouse-debug.html', html.slice(0, 50000));
      return { success: false, message: 'Submit button not found' };
    }

    // Set up success detection BEFORE clicking
    // Greenhouse: native HTML form POST → navigates to /confirmation
    const successPromise = Promise.any([
      page.waitForRequest(
        req => req.url().includes(`/v1/boards/${slug}/jobs/${jobId}/application`) && req.method() === 'POST',
        { timeout: 15000 }
      ),
      page.waitForNavigation({
        url: u => u.includes('confirmation'),
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      }),
    ]).catch(() => null);

    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));
    await submitBtn.hover();
    await page.waitForTimeout(Math.floor(Math.random() * 400 + 200));
    log(`  🖱 Submitting...`);
    await submitBtn.click({ delay: Math.floor(Math.random() * 150 + 50) });

    const result = await successPromise;
    const afterUrl = page.url();
    const pageText = await page.textContent('body').catch(() => '');

    // Check for duplicate application
    if (pageText.match(/already applied|already submitted|previously applied/i)) {
      return { duplicate: true, message: 'Already applied to this role' };
    }

    if (result) {
      const resultUrl = typeof result.url === 'function' ? result.url() : afterUrl;
      if (resultUrl.includes('confirmation')) {
        return { success: true, message: `Submitted via Greenhouse ✓ (confirmed)` };
      }
      return { success: true, message: `Submitted via Greenhouse ✓ (POST intercepted)` };
    }

    // DOM fallbacks
    if (pageText.match(/thank you|application received|submitted|we received/i)) {
      return { success: true, message: 'Submitted via Greenhouse ✓ (DOM)' };
    }
    if (afterUrl.includes('confirmation')) {
      return { success: true, message: `Submitted via Greenhouse ✓ (URL)` };
    }
    if (pageText.match(/error|required|invalid|can.t be blank/i)) {
      return { success: false, message: `Validation error` };
    }

    // Save debug artifacts
    await page.screenshot({ path: '/tmp/greenhouse-debug.png', fullPage: true }).catch(() => {});
    const html = await page.content();
    fs.writeFileSync('/tmp/greenhouse-debug.html', html.slice(0, 50000));
    return { success: false, message: `No confirmation at ${afterUrl}` };

  } catch (err) {
    return { success: false, message: `Greenhouse error: ${err.message}` };
  }
}

// ── Lever ─────────────────────────────────────────────────────────────────────
async function submitLever(page, job, resumeText, resumePdfUrl, focus) {
  try {
    const applyUrl = job.url.includes('/apply') ? job.url : `${job.url}/apply`;
    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('lever.co')) {
      return { success: false, manual: true, message: `Custom site: ${finalDomain}` };
    }

    // Upload resume FIRST — Lever auto-parses and fills fields
    if (resumePdfUrl) {
      await uploadResumePdf(page, resumePdfUrl, [
        'input[type="file"][id="resume_file"]',
        'input[type="file"]',
      ]);
      log(`  📎 Resume uploaded — waiting for parse...`);
      await page.waitForTimeout(3500); // Wait for Lever's async parse
    }

    // Clear and fill after parse — guarantees our values win
    // Target precise selectors to avoid triggering LinkedIn OAuth iframe
    await clearAndType(page, 'input[name="name"]', PROFILE.full_name);
    await clearAndType(page, 'input[name="email"]', PROFILE.email);
    await clearAndType(page, 'input[name="phone"]', PROFILE.phone_formatted);

    // Lever LinkedIn exact field name
    await clearAndType(page, 'input[name="urls[LinkedIn]"]', PROFILE.linkedin);

    // Custom questions
    const answers = job.generated_responses || {};
    for (const [question, answer] of Object.entries(answers)) {
      await tryFillByLabel(page, question, String(answer));
    }

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));

    // Lever uses XHR — intercept API call OR /thanks redirect
    const jobId = job.external_id;
    const slug = job.ats_slug;
    const leverPromise = Promise.any([
      page.waitForResponse(
        res => res.url().includes(`/v1/postings/${slug}/${jobId}/apply`) && res.status() === 200,
        { timeout: 15000 }
      ),
      page.waitForNavigation({
        url: u => u.includes('/thanks'),
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      }),
    ]).catch(() => null);

    // Submit with humanized click
    for (const sel of ['button[data-qa="btn-submit"]', '.lever-button-black[type="submit"]', 'button[type="submit"]', 'input[type="submit"]']) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.scrollIntoViewIfNeeded();
        await btn.hover();
        await page.waitForTimeout(Math.floor(Math.random() * 300 + 100));
        await btn.click({ delay: Math.floor(Math.random() * 100 + 50) });
        break;
      }
    }

    const leverResult = await leverPromise;
    const leverUrl = page.url();
    const leverText = await page.textContent('body').catch(() => '');
    log(`  📍 ${leverUrl}`);

    if (leverResult || leverUrl.includes('/thanks')) {
      return { success: true, message: `Submitted via Lever ✓` };
    }
    if (leverText.match(/thank you|application received|submitted/i)) {
      return { success: true, message: 'Submitted via Lever ✓ (DOM)' };
    }

    await page.screenshot({ path: '/tmp/lever-debug.png', fullPage: true }).catch(() => {});
    return { success: false, message: `Lever: no confirmation at ${leverUrl}` };

  } catch (err) {
    return { success: false, message: `Lever error: ${err.message}` };
  }
}

// ── Ashby ─────────────────────────────────────────────────────────────────────
async function submitAshby(page, job, resumeText, resumePdfUrl, focus) {
  try {
    const applyUrl = job.url.includes('/application') ? job.url : `${job.url}/application`;
    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('ashbyhq.com')) {
      return { success: false, manual: true, message: `Custom site: ${finalDomain}` };
    }

    // Standard fields
    await humanType(page, 'input[name*="firstName" i]', PROFILE.first_name) ||
    await humanType(page, 'input[placeholder*="First name" i]', PROFILE.first_name);

    await humanType(page, 'input[name*="lastName" i]', PROFILE.last_name) ||
    await humanType(page, 'input[placeholder*="Last name" i]', PROFILE.last_name);

    await humanType(page, 'input[type="email"]', PROFILE.email);
    await humanType(page, 'input[type="tel"]', PROFILE.phone_formatted);

    for (const sel of ['input[name*="linkedin" i]', 'input[placeholder*="linkedin" i]']) {
      if (await humanType(page, sel, PROFILE.linkedin)) break;
    }

    if (resumePdfUrl) {
      await uploadResumePdf(page, resumePdfUrl, ['input[type="file"]']);
    }

    // Custom questions
    const answers = job.generated_responses || {};
    for (const [question, answer] of Object.entries(answers)) {
      await tryFillByLabel(page, question, String(answer));
    }

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));

    // Ashby uses XHR — intercept API OR /application/success
    // UUID for Ashby is job.external_id
    const ashbyPromise = Promise.any([
      page.waitForResponse(
        res => res.url().includes('/api/non-auth/v1/postings/') &&
               res.url().includes('/apply') &&
               res.status() === 200,
        { timeout: 15000 }
      ),
      page.waitForNavigation({
        url: u => u.includes('/application/success'),
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      }),
    ]).catch(() => null);

    const ashbyBtn = page.locator('[type="submit"], button:has-text("Submit"), button:has-text("Apply")').first();
    if (await ashbyBtn.count() > 0) {
      await ashbyBtn.scrollIntoViewIfNeeded();
      await ashbyBtn.hover();
      await page.waitForTimeout(Math.floor(Math.random() * 300 + 100));
      await ashbyBtn.click({ delay: Math.floor(Math.random() * 100 + 50) });
    }

    const ashbyResult = await ashbyPromise;
    const ashbyUrl = page.url();
    const ashbyText = await page.textContent('body').catch(() => '');
    log(`  📍 ${ashbyUrl}`);

    if (ashbyResult || ashbyUrl.includes('/application/success')) {
      return { success: true, message: `Submitted via Ashby ✓` };
    }
    if (ashbyText.match(/thank you|application received|submitted|success/i)) {
      return { success: true, message: 'Submitted via Ashby ✓ (DOM)' };
    }

    await page.screenshot({ path: '/tmp/ashby-debug.png', fullPage: true }).catch(() => {});
    return { success: false, message: `Ashby: no confirmation at ${ashbyUrl}` };

  } catch (err) {
    return { success: false, message: `Ashby error: ${err.message}` };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Human-like typing with random delays
async function humanType(page, selector, value) {
  if (!value) return false;
  try {
    const el = await page.$(selector);
    if (!el) return false;
    await el.click();
    await el.fill('');
    for (const char of value) {
      await page.keyboard.type(char);
      await page.waitForTimeout(Math.floor(Math.random() * 40 + 10));
    }
    await page.waitForTimeout(Math.floor(Math.random() * 200 + 100));
    return true;
  } catch (e) { return false; }
}

// Clear existing value then type — used after Lever auto-parse
async function clearAndType(page, selector, value) {
  if (!value) return false;
  try {
    const el = await page.$(selector);
    if (!el) return false;
    await el.fill('');
    await el.fill(value);
    return true;
  } catch (e) { return false; }
}

// Fill field from list of selectors
async function fillField(page, selectors, value) {
  if (!value) return false;
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.fill(value); return true; }
    } catch (e) {}
  }
  return false;
}

// Handle radio buttons by matching label text
async function handleRadioByText(page, questionRegex, answerRegex) {
  try {
    const fieldBlock = page.locator('div.field', { hasText: questionRegex });
    if (await fieldBlock.count() === 0) return false;
    const label = fieldBlock.locator('label', { hasText: answerRegex });
    if (await label.count() > 0) {
      await label.first().click();
      return true;
    }
  } catch (e) {}
  return false;
}

// Handle select dropdowns by matching label text
async function handleDropdownByText(page, questionRegex, value) {
  try {
    const fieldBlock = page.locator('div.field', { hasText: questionRegex });
    if (await fieldBlock.count() === 0) return false;
    const select = fieldBlock.locator('select');
    if (await select.count() > 0) {
      await select.first().selectOption({ label: value }).catch(() =>
        select.first().selectOption({ value: value.toLowerCase() }).catch(() => {})
      );
      return true;
    }
  } catch (e) {}
  return false;
}

// Fill field by matching label text (for custom questions)
async function tryFillByLabel(page, labelText, value) {
  if (!value || !labelText) return false;
  try {
    const labels = await page.$$('label');
    for (const label of labels) {
      const text = await label.textContent();
      if (text && text.toLowerCase().includes(labelText.toLowerCase().slice(0, 25))) {
        const forAttr = await label.getAttribute('for');
        if (forAttr) {
          const input = await page.$(`#${CSS.escape(forAttr)}`);
          if (input) {
            const tag = await input.evaluate(el => el.tagName.toLowerCase());
            const type = await input.evaluate(el => el.type || '');
            if (tag === 'textarea' || (tag === 'input' && !['radio', 'checkbox', 'file', 'hidden'].includes(type))) {
              await input.fill(value);
              return true;
            }
            if (tag === 'select') {
              await input.selectOption({ label: value }).catch(() => {});
              return true;
            }
          }
        }
      }
    }
  } catch (e) {}
  return false;
}

// Upload resume PDF from URL
async function uploadResumePdf(page, pdfUrl, selectors) {
  try {
    let fileInput = null;
    for (const sel of selectors) {
      fileInput = await page.$(sel);
      if (fileInput) break;
    }
    if (!fileInput) return false;

    const response = await fetch(pdfUrl);
    if (!response.ok) return false;

    const buffer = await response.arrayBuffer();
    const tmpPath = `/tmp/resume_${Date.now()}.pdf`;
    fs.writeFileSync(tmpPath, Buffer.from(buffer));
    await fileInput.setInputFiles(tmpPath);
    fs.unlinkSync(tmpPath);
    return true;
  } catch (e) {
    log(`  ⚠ Resume upload failed: ${e.message}`);
    return false;
  }
}

function saveLog() {
  fs.writeFileSync('run-log.json', JSON.stringify(runLog, null, 2));
  log(`\n📝 Run log saved`);
}

main().catch(err => {
  log(`💥 Fatal: ${err.message}`);
  runLog.error = err.message;
  saveLog();
  process.exit(1);
});

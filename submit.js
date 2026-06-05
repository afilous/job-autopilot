/**
 * Job Autopilot — Automated Application Submission
 * Fixed with correct Greenhouse form selectors based on actual HTML inspection
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SUBMISSIONS = 10;
const MIN_SCORE = 75; // only submit 75%+ matches
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
  website: 'https://www.linkedin.com/in/aaron-filous/',
  heard_about: 'LinkedIn',
};

// Companies that use custom career sites — skip automation
const MANUAL_COMPANIES = ['Stripe', 'Databricks', 'Block', 'Intuit', 'Waymo'];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const runLog = { started_at: new Date().toISOString(), dry_run: DRY_RUN, results: [] };

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  log(DRY_RUN ? '🔍 DRY RUN mode' : '🚀 Starting job submission run');

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

  const { data: resumeData } = await supabase
    .from('resumes').select('*').eq('is_active', true).limit(1).single();

  const resumeText = resumeData?.raw_text || '';
  const resumePdfUrl = resumeData?.pdf_url || null;
  log(`📄 Resume: ${resumeData?.filename || 'default'}`);

  // Use camoufox for anti-fingerprint stealth (free, fixes navigator.webdriver at C++ layer)
  // Falls back to standard chromium if camoufox not installed
  let browser;
  try {
    const { firefox } = require('camoufox');
    browser = await firefox.launch({ headless: true });
    log('🦊 Using Camoufox (stealth mode)');
  } catch (e) {
    log('⚠ Camoufox not available, falling back to Chromium');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });
  }

  // Optional: residential proxy via DataImpulse ($1/GB, no monthly fee)
  // Set PROXY_URL secret in GitHub: http://user:pass@geo.iproyal.com:12321
  const PROXY_URL = process.env.PROXY_URL || null;

  let submitted = 0, failed = 0, manual = 0, skipped = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    log(`\n[${i + 1}/${jobs.length}] ${job.job_title} at ${job.company} (${job.ats_type})`);
    log(`  URL: ${job.url}`);
    log(`  Score: ${job.match_score}%`);

    if (DRY_RUN) {
      log('  ⏭ DRY RUN — skipping');
      runLog.results.push({ job_id: job.id, status: 'dry_run' });
      skipped++;
      continue;
    }

    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };
    if (PROXY_URL) {
      contextOptions.proxy = { server: PROXY_URL };
      log('  🔀 Routing through residential proxy');
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // Hide automation signals
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

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
        await supabase.from('applications').update({ status: 'manual', notes: result.message }).eq('id', job.id);
        log(`  → Manual: ${result.message}`);
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
      await supabase.from('applications').update({ status: 'failed', notes: `Exception: ${err.message}` }).eq('id', job.id);
      failed++;
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
    // Fix: Use canonical boards.greenhouse.io URL with #app anchor
    // Do NOT use job-boards subdomain — causes cross-origin cookie blocking
    const jobId = job.external_id;
    const slug = job.ats_slug;
    const applyUrl = `https://boards.greenhouse.io/${slug}/jobs/${jobId}?gh_jid=${jobId}#app`;

    log(`  🌐 Navigating to: ${applyUrl}`);

    // Wire browser console to our logs for debugging
    page.on('console', msg => {
      if (msg.type() === 'error') log(`  🖥 Browser error: ${msg.text()}`);
    });
    page.on('pageerror', err => log(`  🖥 Browser JS error: ${err.message}`));

    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Check for redirect to custom domain
    const finalUrl = page.url();
    const finalDomain = new URL(finalUrl).hostname;
    if (!finalDomain.includes('greenhouse.io')) {
      log(`  ↪ Redirected to custom site: ${finalDomain}`);
      return { success: false, manual: true, message: `Custom career site: ${finalDomain}` };
    }

    log(`  📍 On page: ${finalUrl}`);

    // Wait for form
    const formSelectors = [
      '#application-form',
      'form#application_form', 
      'form[data-form="true"]',
      '.application-form',
      'form',
    ];

    let formFound = false;
    for (const sel of formSelectors) {
      const el = await page.$(sel);
      if (el) { formFound = true; log(`  ✓ Form found: ${sel}`); break; }
    }

    if (!formFound) {
      const title = await page.title();
      log(`  ⚠ No form found. Title: ${title}`);
      log(`  ⚠ URL: ${finalUrl}`);
      return { success: false, message: `No form found at ${finalUrl}` };
    }

    // Fill standard fields with human-like typing
    await humanType(page, '#first_name', PROFILE.first_name);
    await humanType(page, '#last_name', PROFILE.last_name);
    await humanType(page, '#email', PROFILE.email);
    await humanType(page, '#phone', PROFILE.phone_formatted);
    await humanType(page, '#job_application_location', PROFILE.city);

    // LinkedIn — try multiple selectors
    const linkedinSelectors = [
      'input[name*="linkedin" i]',
      'input[id*="linkedin" i]',
      'input[placeholder*="linkedin" i]',
    ];
    for (const sel of linkedinSelectors) {
      if (await humanType(page, sel, PROFILE.linkedin)) break;
    }

    // Website
    for (const sel of ['input[name*="website" i]', 'input[id*="website" i]']) {
      if (await humanType(page, sel, PROFILE.website)) break;
    }

    // Small human pause before custom questions
    await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));

    // Fill custom questions using div.field pattern (confirmed Greenhouse structure)
    const customFields = await page.$$('div.field');
    for (const field of customFields) {
      try {
        const label = await field.$('label');
        if (!label) continue;
        const questionText = await label.innerText();

        // Skip standard fields we already filled
        const inputEl = await field.$('input[type="text"], input[type="url"], textarea');
        if (!inputEl) continue;

        const inputId = await inputEl.getAttribute('id') || '';
        if (['first_name','last_name','email','phone','job_application_location'].includes(inputId)) continue;

        // Check AI answers first
        const answers = job.generated_responses || {};
        let answer = null;
        for (const [q, a] of Object.entries(answers)) {
          if (questionText.toLowerCase().includes(q.toLowerCase().slice(0, 20))) {
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
          log(`  ✓ Filled custom field: \${questionText.slice(0, 50)}`);
        }
      } catch (e) {}
    }

    // Handle "How did you hear" dropdown
    try {
      const heardSelect = await page.$('select[name*="referral" i], select[id*="heard" i], select[name*="heard" i]');
      if (heardSelect) {
        await heardSelect.selectOption({ label: 'LinkedIn' }).catch(() => {});
      }
    } catch (e) {}

    // Fill resume text if field exists
    await fillFieldByMultiple(page, [
      '#resume_text',
      'textarea[name="job_application[resume_text]"]',
    ], resumeText.slice(0, 5000));

    // Upload resume PDF
    if (resumePdfUrl) {
      const uploaded = await uploadResumePdf(page, resumePdfUrl, [
        'input[type="file"][name="job_application[resume]"]',
        'input[type="file"][accept*="pdf"]',
        'input[type="file"]',
      ]);
      if (uploaded) log(`  📎 Resume uploaded`);
    }

    // Fill AI-generated custom question answers
    const answers = job.generated_responses || {};
    if (answers && typeof answers === 'object') {
      for (const [question, answer] of Object.entries(answers)) {
        await tryFillByLabel(page, question, String(answer));
      }
    }

    // Handle work authorization
    await handleDropdownByLabel(page, /authorized.*work|work.*authorized|eligible.*work/i, 'Yes');
    await handleDropdownByLabel(page, /sponsorship|visa sponsor|require.*sponsor/i, 'No');

    // Find submit button
    const submitBtn = page.locator('#submit_app, input[type="submit"][value*="Submit" i], button[type="submit"]').first();
    const btnExists = await submitBtn.count() > 0;

    if (!btnExists) {
      // Save HTML for debugging
      const html = await page.content();
      fs.writeFileSync('/tmp/greenhouse-debug.html', html.slice(0, 50000));
      return { success: false, message: 'Submit button not found — HTML saved for debug' };
    }

    // Fix: Network-level success monitoring (more reliable than DOM text)
    const submissionPromise = page.waitForResponse(
      response =>
        (response.url().includes('/backend/applications') ||
         response.url().includes('/apply') ||
         response.url().includes('/applications')) &&
        response.request().method() === 'POST',
      { timeout: 15000 }
    ).catch(() => null);

    // Fix: Humanized submit — scroll → hover → delayed click (bypasses reCAPTCHA v3)
    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));
    await submitBtn.hover();
    await page.waitForTimeout(Math.floor(Math.random() * 400 + 200));
    log(`  🖱 Clicking submit with human delay...`);
    await submitBtn.click({ delay: Math.floor(Math.random() * 150 + 50) });

    // Check network response first
    const networkResponse = await submissionPromise;
    if (networkResponse) {
      const status = networkResponse.status();
      log(`  📡 Network response: ${status} from ${networkResponse.url()}`);
      if (status === 200 || status === 201 || status === 302) {
        return { success: true, message: `Submitted via Greenhouse ✓ (network ${status})` };
      }
    }

    await page.waitForTimeout(4000);

    // Fallback: check DOM
    const afterUrl = page.url();
    const afterTitle = await page.title();
    const pageText = await page.textContent('body').catch(() => '');

    log(`  📍 After submit URL: ${afterUrl}`);
    log(`  📍 After submit title: ${afterTitle}`);
    log(`  📍 Text snippet: ${pageText.slice(0, 200)}`);

    if (pageText.match(/thank you|application received|submitted|we.ll be in touch|confirmation|we received/i)) {
      return { success: true, message: 'Submitted via Greenhouse form ✓ (DOM confirmed)' };
    }

    if (afterUrl !== applyUrl) {
      return { success: true, message: `Submitted — redirected to ${afterUrl}` };
    }

    if (pageText.match(/error|required|invalid|please fill|can.t be blank|must be/i)) {
      return { success: false, message: `Validation error — check required fields` };
    }

    // Save HTML for debugging if we can't confirm
    const html = await page.content();
    fs.writeFileSync('/tmp/greenhouse-debug.html', html.slice(0, 50000));
    return { success: false, message: `No confirmation detected. Title: ${afterTitle}` };

  } catch (err) {
    return { success: false, message: `Greenhouse error: ${err.message}` };
  }
}

// ── Lever ─────────────────────────────────────────────────────────────────────
async function submitLever(page, job, resumeText, resumePdfUrl) {
  try {
    const applyUrl = job.url.includes('/apply') ? job.url : `${job.url}/apply`;
    log(`  🌐 Navigating to: ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('lever.co')) {
      return { success: false, manual: true, message: `Custom site: ${finalDomain}` };
    }

    // Upload resume FIRST on Lever — it auto-parses and fills fields
    if (resumePdfUrl) {
      await uploadResumePdf(page, resumePdfUrl, ['input[type="file"]']);
      await page.waitForTimeout(3000); // Wait for parse
    }

    // Lever form fields with human typing
    await humanType(page, 'input[name="name"]', PROFILE.full_name);
    await humanType(page, 'input[name="email"]', PROFILE.email);
    await humanType(page, 'input[name="phone"]', PROFILE.phone_formatted);

    // Lever LinkedIn — exact field name confirmed
    await humanType(page, 'input[name="urls[LinkedIn]"]', PROFILE.linkedin);
    // Fallback
    await fillFieldByMultiple(page, [
      'input[name*="linkedin" i]',
      'input[placeholder*="linkedin" i]',
    ], PROFILE.linkedin);

    // Resume text
    await fillFieldByMultiple(page, [
      'textarea[name="resume"]',
      '#resume-text',
    ], resumeText.slice(0, 5000));

    const answers = job.generated_responses || {};
    if (answers && typeof answers === 'object') {
      for (const [question, answer] of Object.entries(answers)) {
        await tryFillByLabel(page, question, String(answer));
      }
    }

    await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));

    // Submit
    const submitSelectors = [
      'button[data-qa="btn-submit"]',
      '.lever-button-black[type="submit"]',
      'button[type="submit"]',
      'input[type="submit"]',
    ];

    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); break; }
      } catch (e) {}
    }

    await page.waitForTimeout(3000);
    const pageText = await page.textContent('body').catch(() => '');
    log(`  📍 After submit: ${page.url()}`);

    if (pageText.match(/thank you|application received|submitted/i)) {
      return { success: true, message: 'Submitted via Lever form ✓' };
    }

    return { success: false, message: `Lever: no confirmation. URL: ${page.url()}` };

  } catch (err) {
    return { success: false, message: `Lever error: ${err.message}` };
  }
}

// ── Ashby ─────────────────────────────────────────────────────────────────────
async function submitAshby(page, job, resumeText, resumePdfUrl) {
  try {
    const applyUrl = job.url.includes('/application') ? job.url : `${job.url}/application`;
    log(`  🌐 Navigating to: ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('ashbyhq.com')) {
      return { success: false, manual: true, message: `Custom site: ${finalDomain}` };
    }

    await fillFieldByMultiple(page, [
      'input[name*="firstName" i]',
      'input[placeholder*="First name" i]',
      'input[aria-label*="First name" i]',
    ], PROFILE.first_name);

    await fillFieldByMultiple(page, [
      'input[name*="lastName" i]',
      'input[placeholder*="Last name" i]',
      'input[aria-label*="Last name" i]',
    ], PROFILE.last_name);

    await fillFieldByMultiple(page, [
      'input[type="email"]',
      'input[name*="email" i]',
    ], PROFILE.email);

    await fillFieldByMultiple(page, [
      'input[type="tel"]',
      'input[name*="phone" i]',
    ], PROFILE.phone_formatted);

    await fillFieldByMultiple(page, [
      'input[name*="linkedin" i]',
      'input[placeholder*="linkedin" i]',
    ], PROFILE.linkedin);

    if (resumePdfUrl) {
      await uploadResumePdf(page, resumePdfUrl, ['input[type="file"]']);
    }

    const answers = job.generated_responses || {};
    if (answers && typeof answers === 'object') {
      for (const [question, answer] of Object.entries(answers)) {
        await tryFillByLabel(page, question, String(answer));
      }
    }

    await page.click('[type="submit"], button:has-text("Submit"), button:has-text("Apply")').catch(() => {});
    await page.waitForTimeout(3000);

    const pageText = await page.textContent('body').catch(() => '');
    log(`  📍 After submit: ${page.url()}`);

    if (pageText.match(/thank you|application received|submitted|success/i)) {
      return { success: true, message: 'Submitted via Ashby form ✓' };
    }

    return { success: false, message: `Ashby: no confirmation. URL: ${page.url()}` };

  } catch (err) {
    return { success: false, message: `Ashby error: ${err.message}` };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fillFieldByMultiple(page, selectors, value) {
  if (!value) return false;
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.fill(value);
        return true;
      }
    } catch (e) {}
  }
  return false;
}

// Human-like typing with random delays between keystrokes
async function humanType(page, selector, value) {
  if (!value) return false;
  try {
    const el = await page.$(selector);
    if (!el) return false;
    await el.click();
    await el.fill(''); // clear first
    for (const char of value) {
      await page.keyboard.type(char);
      await page.waitForTimeout(Math.floor(Math.random() * 40 + 10)); // 10-50ms per char
    }
    await page.waitForTimeout(Math.floor(Math.random() * 300 + 200)); // pause after field
    return true;
  } catch (e) {
    return false;
  }
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

async function handleDropdownByLabel(page, labelRegex, value) {
  try {
    const selects = await page.$$('select');
    for (const select of selects) {
      const id = await select.getAttribute('id');
      const label = id ? await page.$(`label[for="${id}"]`) : null;
      const labelText = label ? await label.textContent() : '';
      if (labelRegex.test(labelText)) {
        await select.selectOption({ label: value }).catch(() =>
          select.selectOption({ value: value.toLowerCase() }).catch(() => {})
        );
        return true;
      }
    }
  } catch (e) {}
  return false;
}

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

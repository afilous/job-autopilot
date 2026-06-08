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

  // Recovery: release any jobs stuck in 'processing' for more than 30 minutes
  // This happens when GitHub Actions crashes or times out mid-run
  const staleWindow = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { error: rollbackError, count: rollbackCount } = await supabase
    .from('applications')
    .update({ status: 'queued', notes: 'Auto-recovered from stale processing state' })
    .eq('status', 'processing')
    .lt('started_at', staleWindow);
  if (!rollbackError && rollbackCount > 0) log('♻ Recovered ' + rollbackCount + ' stale jobs back to queued');

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

  // Reduce global timeouts to avoid long hangs
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
      bypassCSP: true,
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
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);

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


// Poll Gmail for Greenhouse security verification codes
async function pollForSecurityCode() {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    log('  ⚠ Gmail credentials not configured for security code polling');
    return null;
  }
  
  try {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const startTime = Date.now();
    const searchAfter = Math.floor((startTime - 120000) / 1000); // last 2 min

    while (Date.now() - startTime < 60000) {
      try {
        // Use explicit UTC timestamp to avoid timezone issues on GitHub Actions
        const afterTimestamp = Math.floor((Date.now() - 600000) / 1000); // 10 min ago in UTC epoch
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: `from:no-reply@us.greenhouse-mail.io after:${afterTimestamp}`,
          maxResults: 5,
        });

        if (res.data.messages && res.data.messages.length > 0) {
          for (const msg of res.data.messages) {
            const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
            const snippet = full.data.snippet || '';
            const bodyData = full.data.payload?.body?.data || 
              full.data.payload?.parts?.[0]?.body?.data || '';
            const bodyText = bodyData ? Buffer.from(bodyData, 'base64').toString() : '';
            const fullText = snippet + ' ' + bodyText;
            
            // Greenhouse sends exactly 8 alphanumeric chars e.g. "tjka9Bi1"
            const codeMatch = fullText.match(/([a-zA-Z0-9]{8})/g);
            if (codeMatch) {
              const commonWords = ['security','passcode','confirm','complete','required','provided','yourself','november','december','january','february','application','submitted','greenhouse'];
              const code = codeMatch.find(c => !commonWords.includes(c.toLowerCase()));
              if (code) {
                log('  ✅ Found security code in Gmail: ' + code);
                return code;
              }
            }
          }
        }
      } catch(e) {}
      
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch(e) {
    log('  ⚠ Gmail polling error: ' + e.message);
  }
  return null;
}

// Strict priority-ordered answer mapping for Greenhouse dropdowns
function getDropdownAnswer(labelText) {
  const c = labelText.toLowerCase();

  // Priority 1: Sponsorship/visa — must come first before any other matching
  if (c.includes('sponsor') || c.includes('visa') || c.includes('immigration') ||
      c.includes('work authorization') || c.includes('future re')) return 'No';

  // Priority 2: Work authorization — authorized/eligible to work
  if (c.includes('authorized') || c.includes('eligible to work') ||
      c.includes('legally') || c.includes('right to work')) return 'Yes';

  // Priority 3: Non-compete / prior employer agreements
  if (c.includes('non-compete') || c.includes('non compete') ||
      c.includes('non-solicit') || c.includes('agreement with') ||
      c.includes('former employer')) return 'No';

  // Priority 4: Hybrid/in-office/relocate
  if (c.includes('hybrid') || c.includes('in-office') || c.includes('in office') ||
      c.includes('in-person') || c.includes('relocat') || c.includes('willing to work') ||
      c.includes('commit to being')) return 'Yes';

  // Priority 5: Previously worked at company
  if (c.includes('previously worked') || c.includes('worked for') ||
      c.includes('formerly') || c.includes('ever worked')) return 'No';

  // Priority 6: State/province/metro
  if (c.includes('state of residence') || c.includes('current state') ||
      c.includes('province')) return 'California';
  if (c.includes('metro') || c.includes('san francisco bay') ||
      c.includes('based in sf') || c.includes('based in san francisco')) return 'San Francisco Bay';

  // Priority 7: EEOC/diversity
  if (c.includes('veteran')) return 'I am not a protected veteran';
  if (c.includes('disability')) return 'No, I do not have a disability';
  if (c.includes('gender') || c.includes('race') || c.includes('ethnicity') ||
      c.includes('ethnic') || c.includes('sexual orientation') || c.includes('lgbtq') ||
      c.includes('transgender') || c.includes('identify as') || c.includes('identify my') ||
      c.includes('lgbtqia') || c.includes('pronoun')) {
    return 'Decline';
  }

  // Priority 8: Education dropdowns
  if (c.includes('school') || c.includes('university') || c.includes('college') || 
      c.includes('institution')) return 'Georgetown University';
  if (c.includes('degree') || c.includes('level of education')) return "Master's";
  if (c.includes('discipline') || c.includes('field of study') || c.includes('major')) return 'European Studies';

  // Priority 9: AI policy
  if (c.includes('ai policy') || c.includes('artificial intelligence policy') ||
      c.includes('use of ai') || c.includes('ai tool') || c.includes('used ai')) return 'No';

  // Priority 10: Referral source
  if (c.includes('hear about') || c.includes('how did you') ||
      c.includes('source') || c.includes('referred')) return 'LinkedIn';

  // Priority 9: SQL/technical skills
  if (c.includes('sql') || c.includes('advanced knowledge')) return 'Yes';

  // Priority 10: AI tools
  if (c.includes('ai tool') || c.includes('artificial intelligence')) return 'Yes';

  // Priority 11: Yes/No catch-all for binary questions
  if (c.includes('do you') || c.includes('are you') || c.includes('can you') ||
      c.includes('will you') || c.includes('have you')) return 'Yes';

  return null;
}

async function submitGreenhouse(page, job, resumeText, resumePdfUrl, focus) {
  try {
    const jobId = job.external_id;
    const slug = job.ats_slug;
    const applyUrl = `https://boards.greenhouse.io/${slug}/jobs/${jobId}?gh_jid=${jobId}#app`;

    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'load', timeout: 30000 });
    
    // Wait for form to fully render
    try {
      await page.waitForSelector(
        '#application_form, #app, #first_name, input[id="first_name"]',
        { state: 'visible', timeout: 12000 }
      );
      await page.waitForTimeout(1500);
    } catch (e) {
      log('  ⚠ Form not found after 12s — checking page state');
    }

    const finalUrl = page.url();
    const finalDomain = new URL(finalUrl).hostname;
    if (!finalDomain.includes('greenhouse.io')) {
      // Mark known custom-site companies as manual permanently
      const knownCustomSites = ['fivetran.com', 'airbnb.com', 'okta.com', 'lyft.com',
        'pinterestcareers.com', 'careerpuck.com', 'samsara.com', 'databricks.com'];
      if (knownCustomSites.some(s => finalDomain.includes(s))) {
        try {
          await supabase.from('companies')
            .update({ active: false, notes: 'custom career site — cannot automate' })
            .eq('ats_slug', job.ats_slug);
        } catch(e) {}
        log(`  📋 Deactivated custom-site company: ${job.company}`);
      }
      return { success: false, manual: true, message: `Custom site: ${finalDomain}` };
    }

    // Save debug HTML to understand form structure
    const debugHtml = await page.content();
    fs.writeFileSync('/tmp/greenhouse-debug.html', debugHtml.slice(0, 100000));
    log(`  📄 Debug HTML saved (${debugHtml.length} chars)`);

    // Check what form fields actually exist
    const fieldIds = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input, textarea, select');
      return [...inputs].map(el => ({ id: el.id, name: el.name, type: el.type, placeholder: el.placeholder })).filter(el => el.id || el.name);
    });
    log(`  📋 Form fields found: ${JSON.stringify(fieldIds.slice(0, 15))}`);

    // Check form exists
    const formExists = await page.$('form, #application-form, .application-form, #main_fields');
    if (!formExists) {
      return { success: false, message: `No form found at ${finalUrl}` };
    }

    // Standard fields — new Greenhouse form uses different IDs
    await humanType(page, '#first_name', PROFILE.first_name);
    await humanType(page, '#last_name', PROFILE.last_name);
    await humanType(page, '#preferred_name', PROFILE.first_name); // some boards require this
    await humanType(page, '#email', PROFILE.email);
    await humanType(page, '#phone', PROFILE.phone_formatted);

    // Location — new form uses #candidate-location with autocomplete
    try {
      const locField = await page.$('#candidate-location, #job_application_location');
      if (locField) {
        await locField.click();
        await locField.fill('');
        await page.waitForTimeout(300);
        await locField.type(PROFILE.city, { delay: 50 });
        await page.waitForTimeout(800);
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        log(`  ✓ Location: ${PROFILE.city}`);
      }
    } catch (e) {
      log(`  ⚠ Location field: ${e.message}`);
    }

    // Country — Greenhouse uses reactive autocomplete, must type + ArrowDown + Enter
    try {
      const countryField = await page.$('#country, input[id*="country" i]');
      if (countryField) {
        await countryField.click();
        await countryField.fill('');
        await page.waitForTimeout(300);
        await countryField.type('United States', { delay: 50 });
        await page.waitForTimeout(1000); // Wait for dropdown to populate
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        log('  ✓ Country: United States');
      } else {
        // Try select dropdown
        const countrySelect = await page.$('select[id*="country" i]');
        if (countrySelect) {
          await countrySelect.selectOption({ label: 'United States' }).catch(() =>
            countrySelect.selectOption({ value: 'US' }).catch(() => {}));
          log('  ✓ Country select: United States');
        }
      }
    } catch (e) {
      log(`  ⚠ Country field: ${e.message}`);
    }

    // LinkedIn — try multiple patterns
    for (const sel of [
      'input[name*="linkedin" i]', 
      'input[id*="linkedin" i]', 
      'input[placeholder*="linkedin" i]',
      'input[id*="LinkedIn"]',
      '[id="question_linkedin"]',
    ]) {
      if (await humanType(page, sel, PROFILE.linkedin)) { log('  ✓ LinkedIn filled'); break; }
    }

    // Website
    for (const sel of ['input[name*="website" i]', 'input[id*="website" i]']) {
      if (await humanType(page, sel, PROFILE.website)) break;
    }

    // Upload cover letter if field exists (required or not)
    try {
      const coverLetterInput = await page.$('input[type="file"][id="cover_letter"]');
      if (coverLetterInput) {
        const clPath = '/tmp/aaron_cover_letter.txt';
        const clText = `Dear Hiring Manager,

I am excited to apply for this role. With 10+ years in strategy and operations — including leading a $200M portfolio consolidation at Enova International and scaling Product School from $2M to $6M in revenue — I bring a proven track record of driving operational excellence and business growth.

My experience spans cross-functional leadership, GTM strategy, revenue operations, and building scalable systems that deliver measurable impact. I am confident my background aligns strongly with the needs of this role and I look forward to contributing to your team.

Please find additional details in my attached resume.

Best regards,
Aaron Filous
filousaaron@gmail.com | (650) 291-3142
linkedin.com/in/aaron-filous`;
        fs.writeFileSync(clPath, clText);
        await coverLetterInput.setInputFiles(clPath);
        log('  📎 Cover letter uploaded');
      }
    } catch(e) { log('  ⚠ Cover letter: ' + e.message); }

    // Upload resume PDF
    let resumeUploaded = false;
    if (resumePdfUrl) {
      resumeUploaded = await uploadResumePdf(page, resumePdfUrl, [
        'input[type="file"][id="resume"]',
        'input[type="file"][id="resume_file"]',
        'input[type="file"][name="job_application[resume]"]',
        'input[type="file"][accept*="pdf"]',
        'input[type="file"]',
      ]);
      if (resumeUploaded) log(`  📎 Resume PDF uploaded`);
      else log(`  ⚠ Resume PDF upload failed — falling back to text`);
    } else {
      log(`  ⚠ No resume PDF URL — using text fallback`);
    }

    // Resume text — always fill as fallback
    const resumeTextFilled = await fillField(page, [
      '#resume_text',
      'textarea[name="job_application[resume_text]"]',
      'textarea[id*="resume"]',
    ], resumeText.slice(0, 5000));
    if (resumeTextFilled) log(`  📝 Resume text filled`);
    else if (!resumeUploaded) log(`  ❌ Neither PDF nor text resume could be filled — submission will likely fail`);

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));

    // Work authorization radio buttons
    await handleRadioByText(page, /authorized.*work|work.*authorized|eligible.*work/i, /^Yes$/i);
    await handleRadioByText(page, /require.*sponsorship|visa sponsor|need.*sponsor/i, /^No$/i);

    // Broader radio sweep for willing/authorized/in-person questions
    try {
      const allFields = await page.$$('div.field, div[class*="field"]');
      for (const field of allFields) {
        const fieldText = (await field.textContent() || '').toLowerCase();
        if (/willing|authorized|legally|currently.*us|relocate|in.person|on.?site/i.test(fieldText)) {
          const labels = await field.$$('label');
          for (const label of labels) {
            const lt = (await label.textContent() || '').toLowerCase().trim();
            if (lt === 'yes' || lt === 'true' || lt === 'i am' || lt === 'willing') {
              await label.click();
              log('  ✓ Radio Yes: ' + fieldText.slice(0, 40));
              break;
            }
          }
        }
        if (/sponsorship|visa|sponsor/i.test(fieldText)) {
          const labels = await field.$$('label');
          for (const label of labels) {
            const lt = (await label.textContent() || '').toLowerCase().trim();
            if (lt === 'no' || lt === 'false' || lt === 'i do not') {
              await label.click();
              log('  ✓ Radio No: ' + fieldText.slice(0, 40));
              break;
            }
          }
        }
      }
    } catch(e) {
      log('  ⚠ Radio sweep: ' + e.message);
    }

    // Work authorization dropdowns
    await handleDropdownByText(page, /authorized.*work|work.*authorized/i, 'Yes');
    await handleDropdownByText(page, /require.*sponsorship|visa/i, 'No');

    // How did you hear
    try {
      const heardSel = await page.$('select[name*="referral" i], select[id*="heard" i]');
      if (heardSel) await heardSel.selectOption({ label: 'LinkedIn' }).catch(() => {});
    } catch (e) {}

    // Greenhouse Form Handler — Label-to-Component approach
    // Uses getDropdownAnswer() for strict priority mapping
    // Targets VISIBLE dropdown trigger divs, not hidden backing inputs
    try {
      const allLabels = await page.$$('label');
      for (const label of allLabels) {
        const rawLabel = (await label.textContent() || '');
        const labelText = rawLabel.toLowerCase();
        const forAttr = await label.getAttribute('for');
        if (!forAttr) continue;

        // --- Text / textarea fields ---
        if (forAttr.startsWith('question_') || /^\d/.test(forAttr)) {
          const el = await page.$(`[id="${forAttr}"]`);
          if (!el) continue;

          const tag = await el.evaluate(e => e.tagName.toLowerCase());
          const inputType = await el.evaluate(e => e.type || '');

          if (tag === 'select') {
            // Native select — use strict mapping
            const answer = getDropdownAnswer(rawLabel) || null;
            if (answer) {
              await el.selectOption({ label: answer }).catch(() =>
                el.selectOption({ label: answer + ' to self-identify' }).catch(() =>
                  el.selectOption({ value: answer.toLowerCase() }).catch(() =>
                    el.selectOption({ index: 1 }).catch(() => {}))));
            } else {
              await el.selectOption({ index: 1 }).catch(() => {});
            }
            log('  ✓ Native select: ' + rawLabel.slice(0, 40));

          } else if (tag === 'textarea' || (tag === 'input' && !['file','hidden','radio','checkbox'].includes(inputType))) {
            // Text input — check if it's actually a React dropdown backing field
            const isHiddenBacking = await page.evaluate((id) => {
              const el = document.getElementById(id);
              if (!el) return false;
              const style = window.getComputedStyle(el);
              // Hidden backing fields are typically invisible
              if (style.opacity === '0' || parseFloat(style.opacity) < 0.1) return true;
              if (style.position === 'absolute' && (style.zIndex === '-1' || parseInt(style.zIndex) < 0)) return true;
              if (style.visibility === 'hidden') return true;
              // Check siblings for React dropdown indicators
              const siblings = el.parentElement ? [...el.parentElement.children] : [];
              return siblings.some(s => 
                s !== el && (
                  s.getAttribute('role') === 'combobox' ||
                  (s.className && typeof s.className === 'string' && 
                   (s.className.includes('css-') || s.className.includes('select') || s.className.includes('Select')))
                )
              );
            }, forAttr).catch(() => false);

            // For question_ fields with type=text: check if getDropdownAnswer returns an answer
          // If yes, it's likely a React dropdown — try dropdown approach first, fall back to text
          const dropdownAnswer = getDropdownAnswer(rawLabel);
          
          if (isHiddenBacking || (dropdownAnswer !== null && inputType === 'text')) {
              // This is a React dropdown — find and click the visible trigger
              const answer = dropdownAnswer;
              if (answer !== null) {
                try {
                  // Walk up from label to find the field container
                  const fieldContainer = await label.evaluateHandle(el => {
                    let p = el.parentElement;
                    for (let i = 0; i < 6; i++) {
                      if (!p) break;
                      const cls = (p.className || '').toString();
                      // Look for field wrapper — Greenhouse uses various class patterns
                      if (cls.includes('field') || cls.includes('Field') || 
                          p.tagName === 'LI' || p.tagName === 'SECTION' ||
                          (p.children.length > 1 && p.querySelector('label'))) return p;
                      p = p.parentElement;
                    }
                    return el.parentElement;
                  });

                  // Find the visible dropdown trigger — react-select, select2, or combobox
                  const trigger = await fieldContainer.$(
                    '[class*="css-"][class*="container"], [class*="css-"][class*="control"], ' +
                    '[role="combobox"], div[class*="Select"], div[class*="select__control"], ' +
                    '.select2-choice, .select2-container, .select2-selection'
                  ).catch(() => null);
                  
                  if (trigger) {
                    const triggerVisible = await trigger.isVisible().catch(() => false);
                    if (triggerVisible) {
                      await trigger.scrollIntoViewIfNeeded();
                      await trigger.click({ timeout: 3000, force: true });
                      await page.waitForTimeout(600);

                      const answer_lower = answer.toLowerCase();
                      const options = await page.$$('[role="option"], [class*="option"], ul[role="listbox"] li');
                      let picked = false;

                      for (const opt of options) {
                        const optText = (await opt.innerText().catch(() => '')).toLowerCase().trim();
                        if (optText.includes(answer_lower) || 
                            answer_lower.includes(optText.slice(0, 20)) ||
                            (answer === 'Decline' && (optText.includes('decline') || optText.includes('not wish') || optText.includes('prefer not') || optText.includes('choose not'))) ||
                            (answer === 'No' && (optText === 'no' || optText.startsWith('no,') || optText.startsWith('no '))) ||
                            (answer === 'Yes' && (optText === 'yes' || optText.startsWith('yes,') || optText.startsWith('yes '))) ||
                            (answer === 'California' && optText.includes('california')) ||
                            (answer === 'San Francisco Bay' && optText.includes('san francisco')) ||
                            (answer === 'LinkedIn' && optText.includes('linkedin')) ||
                            (answer === 'I am not a protected veteran' && (optText.includes('not a protected') || optText.includes('not a veteran') || optText.includes('i am not'))) ||
                            (answer === 'No, I do not have a disability' && (optText.includes('do not have') || optText.includes('no disability') || optText.startsWith('no, i')))) {
                          await opt.click({ timeout: 1500 });
                          picked = true;
                          log('  ✓ React dropdown [' + answer + ']: ' + rawLabel.slice(0, 40));
                          break;
                        }
                      }

                      if (!picked && options.length > 0) {
                        for (const opt of options) {
                          const optText = (await opt.innerText().catch(() => '')).trim();
                          if (optText && !optText.toLowerCase().includes('select') && 
                              !optText.toLowerCase().includes('not in the us') &&
                              !optText.toLowerCase().includes('choose')) {
                            await opt.click({ timeout: 1500 });
                            log('  ✓ React dropdown (first): ' + optText.slice(0, 30));
                            picked = true;
                            break;
                          }
                        }
                      }
                      
                      if (!picked) log('  ⚠ No options found for: ' + rawLabel.slice(0, 30));
                      await page.waitForTimeout(200);
                    } else {
                      log('  ⚠ Trigger not visible: ' + rawLabel.slice(0, 30));
                    }
                  } else {
                    // No trigger found — try clicking the element itself
                    log('  ⚠ No css- trigger found, trying direct click: ' + rawLabel.slice(0, 30));
                    try {
                      await el.click({ timeout: 2000 });
                      await page.waitForTimeout(400);
                      const options = await page.$$('[role="option"]');
                      for (const opt of options) {
                        const optText = (await opt.innerText().catch(() => '')).toLowerCase().trim();
                        if (optText.includes(answer.toLowerCase())) {
                          await opt.click({ timeout: 1500 });
                          log('  ✓ Direct click dropdown: ' + optText.slice(0, 30));
                          break;
                        }
                      }
                    } catch(ce) {}
                  }
                } catch(e) {
                  log('  ⚠ React dropdown error (' + e.message.slice(0, 40) + '): ' + rawLabel.slice(0, 30));
                }
              }
            } else {
              // Regular visible text input — comprehensive answer map
              let answer = null;
              const lt = labelText.toLowerCase();

              // Personal info
              if (/linkedin/i.test(lt)) answer = PROFILE.linkedin;
              else if (/website|portfolio|personal site/i.test(lt)) answer = PROFILE.linkedin;
              else if (/github/i.test(lt)) answer = 'https://github.com/afilous';
              else if (/twitter|x\.com/i.test(lt)) answer = '';
              else if (/preferred.*name|name.*prefer|preferred first|first name/i.test(lt)) answer = PROFILE.first_name;
              else if (/last name|surname/i.test(lt)) answer = PROFILE.last_name;
              else if (/full.*name|legal.*name|name.*legal/i.test(lt)) answer = PROFILE.full_name;
              else if (/pronunc/i.test(lt)) answer = 'Aaron (air-on)';
              else if (/pronouns/i.test(lt)) answer = 'He/Him';
              else if (/city/i.test(lt)) answer = 'San Mateo';
              else if (/zip|postal/i.test(lt)) answer = '94401';
              else if (/address/i.test(lt)) answer = 'San Mateo, CA 94401';

              // Education
              else if (/school|university|college|institution/i.test(lt)) answer = 'Georgetown University';
              else if (/degree|level of education/i.test(lt)) answer = "Master's";
              else if (/discipline|field of study|major|area of study/i.test(lt)) answer = 'European Studies';
              else if (/gpa/i.test(lt)) answer = '3.7';
              else if (/graduation|grad.*year|year.*grad/i.test(lt)) answer = '2015';

              // Work
              else if (/company|employer|recent.*company|current.*company/i.test(lt)) answer = 'Stealth Startup';
              else if (/title|position|role.*current|current.*role/i.test(lt)) answer = 'Strategy & Operations Lead';
              else if (/salary|compensation|pay expectation|desired.*pay/i.test(lt)) answer = '145000';
              else if (/years.*experience|experience.*years/i.test(lt)) answer = '10';
              else if (/start.*date|available|earliest.*start/i.test(lt)) answer = 'Immediately';

              // Essay questions
              else if (/why.*work|why.*join|why.*interest|what excites|what draws/i.test(lt)) answer = 'I am excited to apply my 10+ years of strategy and operations experience. At Enova International I led cross-functional initiatives including a $200M portfolio consolidation and drove a 200% increase in SDR productivity. I am drawn to this opportunity because it combines my passion for building scalable systems with a mission-driven team.';
              else if (/why.*you|what makes you|what.*qualif|fit for this/i.test(lt)) answer = 'My background spans strategy, operations, and cross-functional leadership at Enova International, Product School, App Academy, and Promotable. I consistently translate complex problems into scalable operational systems and have a track record of delivering measurable results.';
              else if (/experience|background|describe|tell us about/i.test(lt)) answer = 'My background spans 10+ years in strategy and operations roles. At Enova International I led a $200M portfolio consolidation, built SDR operations from the ground up, and drove cross-functional alignment across product, finance, and go-to-market teams.';
              else if (/sql/i.test(lt)) answer = 'Yes, I have advanced SQL skills including complex joins, window functions, and query optimization.';
              else if (/cover.*letter|additional.*info|anything.*else|other.*information/i.test(lt)) answer = 'Please see my attached cover letter and resume for additional details about my background and qualifications.';

              // Source/referral
              else if (/hear.*about|how.*find|source|referred/i.test(lt)) answer = 'LinkedIn';
              else if (/familiar.*with|how familiar/i.test(lt)) answer = 'Somewhat familiar';

              // Acknowledgments
              else if (/acknowledge|confirm|agree|certify/i.test(lt)) answer = 'Yes';
              else if (/first.*gen|generation/i.test(lt)) answer = 'Yes';

              // Catch-all — use AI responses only if they don't reference wrong company
              else {
                const responses = job.generated_responses || {};
                const companyName = (job.company || '').toLowerCase();
                for (const [q, a] of Object.entries(responses)) {
                  if (lt.includes(q.toLowerCase().slice(0, 20))) {
                    const aStr = String(a).toLowerCase();
                    // Skip if answer mentions a different company by name
                    const mentionsWrongCompany = aStr.includes('why ' + companyName) === false &&
                      ['anthropic','faire','intercom','figma','affirm','gusto','chime','verkada',
                       'mixpanel','amplitude','wonderschool','loop','waymo','ramp'].some(c => 
                        c !== companyName && aStr.includes(c));
                    if (!mentionsWrongCompany) { answer = String(a); break; }
                  }
                }
                if (!answer) answer = 'Please see my attached resume for details.';
              }
              await el.fill((answer || '').slice(0, 500));
              log('  ✓ Text input: ' + rawLabel.slice(0, 50));
            }
          }
        }
      }
    } catch (e) {
      log('  ⚠ Form handler error: ' + e.message);
    }

    // EEOC fields by label text — catches Amplitude-style fields without standard IDs
    try {
      const eeocLabels = await page.$$('label');
      for (const lbl of eeocLabels) {
        const lblText = (await lbl.textContent().catch(() => '')).toLowerCase().trim();
        if (!lblText) continue;
        const isEeoc = /gender|race|ethnic|sexual orient|disability|veteran|lgbtq|pronoun|transgender/.test(lblText);
        if (!isEeoc) continue;
        
        const forAttr = await lbl.getAttribute('for');
        if (!forAttr) continue;
        
        // Try to find and click the dropdown trigger near this label
        const container = await lbl.evaluateHandle(el => {
          let p = el.parentElement;
          for (let i = 0; i < 5; i++) {
            if (!p) break;
            if (p.children.length > 1) return p;
            p = p.parentElement;
          }
          return el.parentElement;
        });
        
        const trigger = await container.$(
          '[class*="css-"][class*="control"], [class*="css-"][class*="container"], [role="combobox"]'
        ).catch(() => null);
        
        if (trigger && await trigger.isVisible().catch(() => false)) {
          await trigger.click({ timeout: 2000, force: true });
          await page.waitForTimeout(600);
          
          const options = await page.$$('[role="option"]');
          let picked = false;
          for (const opt of options) {
            const t = (await opt.innerText().catch(() => '')).toLowerCase();
            if (t.includes('decline') || t.includes('not wish') || t.includes('prefer not') ||
                t.includes('choose not') || t.includes('do not have') || t.includes('not a protected')) {
              await opt.click({ timeout: 1500 });
              log('  ✓ EEOC label dropdown: ' + lblText.slice(0, 30));
              picked = true;
              break;
            }
          }
          if (!picked && options.length > 0) {
            // Pick last option (usually "Decline to self-identify")
            const lastOpt = options[options.length - 1];
            const lastText = (await lastOpt.innerText().catch(() => '')).trim();
            if (lastText && !lastText.toLowerCase().includes('select')) {
              await lastOpt.click({ timeout: 1500 });
              log('  ✓ EEOC label dropdown (last): ' + lastText.slice(0, 30));
            }
          }
          await page.waitForTimeout(300);
        }
      }
    } catch(e) {
      log('  ⚠ EEOC label handler: ' + e.message.slice(0, 50));
    }

    // EEOC fields by known IDs (Verkada pattern)
    for (const eeocField of ['gender','hispanic_ethnicity','veteran_status','disability_status']) {
      try {
        const el = await page.$(`[id="${eeocField}"]`);
        if (!el) continue;
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        if (tag === 'select') {
          await el.selectOption({ index: 1 }).catch(() => {});
          log('  ✓ EEOC select: ' + eeocField);
        } else {
          // React dropdown
          await el.click().catch(() => {});
          await page.waitForTimeout(400);
          const options = await page.$$('[role="option"], ul li, [class*="option"]');
          for (const opt of options) {
            const t = (await opt.innerText().catch(() => '')).toLowerCase();
            if (t.includes('decline') || t.includes('not wish') || t.includes('prefer not') ||
                t.includes('choose not') || t.includes('not a protected') || 
                t.includes('do not have a disability') || t.includes('i am not')) {
              await opt.click();
              log('  ✓ EEOC decline: ' + eeocField);
              break;
            }
          }
          // Fallback: pick first option
          if (options.length > 0) {
            await options[0].click().catch(() => {});
          }
          await page.waitForTimeout(300);
        }
      } catch(e) {}
    }

    // EEOC / Diversity self-identification — decline all to avoid missing field errors
    try {
      const allLabels = await page.$$('label');
      for (const label of allLabels) {
        const text = (await label.innerText() || '').toLowerCase();
        if (text.includes('decline to self-identify') || 
            text.includes('i do not wish to answer') ||
            text.includes('prefer not to say') ||
            text.includes('decline to identify') ||
            text.includes('i do not wish to disclose')) {
          await label.click();
        }
      }
    } catch(e) {}

    // Sweeper disabled — was causing 4+ minute hangs on invisible elements


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
    // Check for security verification code gate (Greenhouse anti-bot)
    try {
      const securityInput = page.locator(
        'input[id*="verification"], input[id*="security"], input[name*="code"], input[placeholder*="code" i]'
      );
      if (await securityInput.count() > 0 && await securityInput.isVisible().catch(() => false)) {
        log('  🔒 Security code gate detected — polling Gmail...');
        const code = await pollForSecurityCode();
        if (code) {
          await securityInput.fill(code);
          await page.waitForTimeout(500);
          const resubmitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
          if (await resubmitBtn.count() > 0) await resubmitBtn.click();
          await page.waitForTimeout(3000);
          log('  🔑 Security code submitted: ' + code);
        } else {
          log('  ⚠ No security code found in Gmail within 45s');
        }
      }
    } catch(se) {}

    // Extract specific validation errors
    const validationErrors = await page.evaluate(() => {
      const errors = document.querySelectorAll('.error, .field-error, [class*="error"], [class*="invalid"]');
      return [...errors].map(el => el.textContent?.trim()).filter(t => t && t.length > 0).slice(0, 10);
    }).catch(() => []);
    
    if (validationErrors.length > 0) {
      log(`  📋 Validation errors: ${validationErrors.join(' | ')}`);
      
      // Check if failures are due to custom questions we couldn't answer
      const isCustomQuestionFailure = validationErrors.some(e => 
        e.match(/why do you|tell us|describe|what is your|how did you hear|willing to|authorized|currently located/i)
      );
      
      if (isCustomQuestionFailure) {
        // Save missing questions to DB for later review
        const missingQs = validationErrors.filter(e => 
          e.match(/why do you|tell us|describe|what is your/i)
        ).join(' | ');
        return { 
          success: false, 
          needs_custom: true,
          message: `Needs custom answers: ${missingQs.slice(0, 200)}` 
        };
      }
      
      return { success: false, message: `Validation: ${validationErrors.slice(0, 3).join(', ')}` };
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

    // Armored field interceptor — matches all visible inputs by context
    log('  📝 Filling Ashby form fields...');
    
    const ESSAY_ANSWER = "I am most proud of building Promotable from scratch to $40k/month in revenue, selecting it as an education partner with 1871 Chicago's top tech incubator. I identified a gap in data skills training, built an automated omnichannel sales funnel, converted a B2C audience to enterprise clients including McDonald's and City Colleges of Chicago. This required building operations, sales, and marketing systems from zero while staying capital efficient.";
    
    const PROFESSIONAL_CONTEXT = 'Experienced strategy and operations leader with 10+ years driving cross-functional initiatives, GTM operations, and revenue efficiency.';

    try {
      const formInputs = await page.$$('input, textarea, [contenteditable="true"]');
      for (const input of formInputs) {
        try {
          const isVisible = await input.isVisible().catch(() => false);
          if (!isVisible) continue;
          
          const inputType = await input.getAttribute('type').catch(() => '');
          if (['file','hidden','submit','checkbox','radio'].includes(inputType)) continue;

          // Anti-honeypot: check actual bounding box and computed styles
          const isHoneypot = await input.evaluate(el => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.opacity === '0' || parseFloat(style.opacity) < 0.1) return true;
            if (style.display === 'none' || style.visibility === 'hidden') return true;
            if (rect.width === 0 || rect.height === 0) return true;
            if (rect.width < 5 || rect.height < 5) return true;
            if (style.position === 'absolute' || style.position === 'fixed') {
              if (parseInt(style.left) < -100 || parseInt(style.top) < -100) return true;
            }
            // Check parent chain for hidden containers
            let p = el.parentElement;
            for (let i = 0; i < 4; i++) {
              if (!p) break;
              const ps = window.getComputedStyle(p);
              if (ps.display === 'none' || ps.visibility === 'hidden' || ps.opacity === '0') return true;
              p = p.parentElement;
            }
            return false;
          }).catch(() => false);
          
          if (isHoneypot) {
            log('  ⚠ Honeypot skipped');
            continue;
          }
          
          // Get context from element and its surroundings
          const meta = await input.evaluate(el => {
            const parent = el.closest('[class*="field"], [class*="form"], label, li, div') || el.parentElement;
            const labelEl = document.querySelector(`label[for="${el.id}"]`);
            return [
              el.getAttribute('placeholder') || '',
              el.getAttribute('aria-label') || '',
              el.getAttribute('name') || '',
              el.getAttribute('id') || '',
              labelEl?.innerText || '',
              parent?.innerText?.slice(0, 100) || ''
            ].join(' ').toLowerCase();
          }).catch(() => '');
          
          const currentVal = await input.evaluate(el => el.value || '').catch(() => '');
          
          // Skip if already filled with real content
          const isPlaceholderVal = ['type here...', 'type here', ''].includes(currentVal.toLowerCase().trim());
          if (currentVal.trim() && !isPlaceholderVal) continue;
          
          let fillVal = null;
          
          if (/name/.test(meta) && !meta.includes('company') && !meta.includes('employer') && !meta.includes('file') && !meta.includes('school')) {
            if (meta.includes('first')) fillVal = PROFILE.first_name;
            else if (meta.includes('last')) fillVal = PROFILE.last_name;
            else fillVal = PROFILE.full_name;
          } else if (/email/.test(meta)) fillVal = currentVal || PROFILE.email;
          else if (/phone|tel/.test(meta)) fillVal = currentVal || PROFILE.phone_formatted;
          else if (/linkedin/.test(meta)) fillVal = PROFILE.linkedin;
          else if (/website|portfolio/.test(meta)) fillVal = PROFILE.linkedin;
          else if (/hear|source|refer/.test(meta)) fillVal = 'LinkedIn';
          else if (/company|employer|recent/.test(meta)) fillVal = 'Stealth Startup';
          else if (/title|role|position/.test(meta)) fillVal = 'Strategy & Operations Lead';
          else if (/proud|exceptional|built|example|accomplish/.test(meta)) fillVal = ESSAY_ANSWER;
          else if (/why|excit|interest|fit|motivat/.test(meta)) fillVal = 'I am excited to apply my 10+ years of strategy and operations experience. At Enova International I led a $200M portfolio consolidation and drove 200% increase in SDR productivity. I look forward to bringing this expertise to your team.';
          else if (/salary|compensation/.test(meta)) fillVal = '145000';
          else if (inputType === 'textarea' && !currentVal.trim()) fillVal = PROFESSIONAL_CONTEXT;
          
          if (fillVal && fillVal !== currentVal) {
            await input.scrollIntoViewIfNeeded();
            await input.click({ clickCount: 3 });
            await input.type(fillVal, { delay: 15 });
            await input.evaluate(e => {
              e.dispatchEvent(new Event('input', { bubbles: true }));
              e.dispatchEvent(new Event('change', { bubbles: true }));
              e.dispatchEvent(new Event('blur', { bubbles: true }));
            });
            log('  ✓ Filled: ' + meta.slice(0, 40).trim());
          }
        } catch(fe) {}
      }
    } catch(e) {
      log('  ⚠ Field interceptor: ' + e.message.slice(0, 50));
    }

    // Location field
    try {
      const locInput = await page.$('input[placeholder*="Location" i], input[aria-label*="location" i], input[placeholder*="City" i]');
      if (locInput && await locInput.isVisible().catch(() => false)) {
        await locInput.click();
        await locInput.type('San Mateo, CA', { delay: 50 });
        await page.waitForTimeout(1000);
        const opt = await page.$('[role="option"], [class*="option"]');
        if (opt) await opt.click();
        else { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); }
        log('  ✓ Ashby location filled');
      }
    } catch(e) {}

    // Check and click any consent/privacy checkboxes
    try {
      const checkboxes = await page.$$('input[type="checkbox"]');
      for (const cb of checkboxes) {
        if (!await cb.isChecked().catch(() => true)) {
          await cb.evaluate(el => el.click());
        }
      }
    } catch(e) {}

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

    // Listen for network submission response BEFORE clicking
    const networkPromise = page.waitForResponse(resp => {
      const url = resp.url();
      return url.includes('ashbyhq.com') && 
             (url.includes('/application') || url.includes('/apply') || url.includes('/submit')) &&
             resp.request().method() === 'POST';
    }, { timeout: 15000 }).catch(() => null);

    // Pre-submit sweep — handle any unfilled required fields
    try {
      // A. Auto-select first option for any empty native dropdowns
      const allSelects = await page.$$('select');
      for (const sel of allSelects) {
        const val = await sel.evaluate(el => el.value).catch(() => '');
        if (!val) {
          await sel.selectOption({ index: 1 }).catch(() => {});
          log('  ✓ Auto-selected empty dropdown');
        }
      }
    } catch(e) {}

    try {
      // B. Trigger change events on file upload container
      const fileContainer = await page.$('[class*="fileUpload" i], [class*="upload" i], .dropzone, [class*="resume"]');
      if (fileContainer) {
        await fileContainer.evaluate(el => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        });
      }
    } catch(e) {}

    try {
      // C. Select first option in any unchecked radio groups
      const radioGroups = await page.$$('[role="radiogroup"], [class*="radioGroup" i]');
      for (const group of radioGroups) {
        const checked = await group.$('[aria-checked="true"], input:checked');
        if (!checked) {
          const firstOpt = await group.$('[role="radio"], input[type="radio"], label');
          if (firstOpt) {
            await firstOpt.click();
            log('  ✓ Selected first radio option in empty group');
          }
        }
      }
    } catch(e) {}

    // Find Ashby submit button — try multiple selectors
    const ashbyBtnSelectors = [
      'button[type="submit"]',
      'button:has-text("Submit Application")',
      'button:has-text("Submit application")',
      'button:has-text("Submit")',
      'button:has-text("Apply Now")',
      'button:has-text("Apply now")',
      'button:has-text("Apply")',
      '[data-testid*="submit"]',
      '[data-testid*="apply"]',
    ];
    
    let ashbyBtn = null;
    for (const sel of ashbyBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
        ashbyBtn = btn;
        log(`  🔘 Found submit button: ${sel}`);
        break;
      }
    }
    
    if (!ashbyBtn) {
      // Log all buttons on page for debugging
      const allBtns = await page.$$('button');
      const btnTexts = await Promise.all(allBtns.map(b => b.innerText().catch(() => '')));
      log(`  ⚠ No submit button found. Buttons on page: ${btnTexts.filter(Boolean).join(' | ').slice(0, 100)}`);
    } else {
      await ashbyBtn.scrollIntoViewIfNeeded();
      await ashbyBtn.focus();
      await page.waitForTimeout(300);
      
      // Try standard click first
      await ashbyBtn.click({ delay: 50 });
      log(`  🖱 Clicked submit button`);
      await page.waitForTimeout(500);
      
      // If no network request fires, try React-aware pointer events
      const quickCheck = await page.url();
      if (quickCheck.includes('/application') && !quickCheck.includes('success')) {
        log(`  🔄 Trying React pointer events...`);
        await ashbyBtn.evaluate(btn => {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isTrusted: true }));
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, isTrusted: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, isTrusted: true }));
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, isTrusted: true }));
        });
        await page.waitForTimeout(500);
        
        // Last resort: form.requestSubmit()
        await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) {
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit();
            } else {
              form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
          }
        }).catch(() => {});
      }
    }

    // Check network response
    const networkResp = await networkPromise;
    if (networkResp) {
      const status = networkResp.status();
      log(`  📡 Network response: ${status} from ${networkResp.url().slice(0, 60)}`);
      if (status >= 400) {
        return { success: false, message: `Ashby server rejected: ${status}` };
      }
    }

    const ashbyResult = await ashbyPromise;
    const ashbyUrl = page.url();
    log(`  📍 ${ashbyUrl}`);

    // STRICT confirmation — must navigate to /application/success or /thanks
    if (ashbyResult || ashbyUrl.includes('/application/success') || ashbyUrl.includes('/thanks') || ashbyUrl.includes('/confirmation')) {
      return { success: true, message: `Submitted via Ashby ✓` };
    }
    
    // Log network response if we got one
    if (networkResp) {
      log(`  📡 Network POST: ${networkResp.status()} from ${networkResp.url().slice(0, 80)}`);
    } else {
      log(`  📡 No POST network request detected — form may not have submitted`);
    }

    // Check body text ONLY for very specific confirmation phrases — not generic words like "submit" or "success"
    // Check for success container element (more reliable than text matching)
    const successEl = await page.$('[class*="successPage" i], [class*="success-page" i], [class*="confirmation" i], h1:has-text("Thank You"), h1:has-text("Application Submitted")').catch(() => null);
    if (successEl) {
      return { success: true, message: 'Submitted via Ashby ✓ (success element)' };
    }

    // Still on /application — submission did not complete
    log(`  ⚠ Still on /application page — form may not have submitted`);
    
    // Check for validation errors using Ashby-specific selectors
    const ashbyErrorSelectors = [
      'div[class*="_error"]', 'div[class*="_errorMessage"]',
      '[aria-invalid="true"]', 'span[class*="error"]',
      '[class*="error"]', '[class*="invalid"]',
      'p[class*="error"]', '[data-has-errors]'
    ];
    let allErrors = [];
    for (const sel of ashbyErrorSelectors) {
      const els = await page.$$(sel);
      for (const el of els) {
        const t = (await el.textContent().catch(() => '')).trim();
        if (t && t.length > 2 && !allErrors.includes(t)) allErrors.push(t);
      }
    }
    if (allErrors.length > 0) {
      log(`  📋 Ashby validation errors: ${allErrors.slice(0, 5).join(' | ')}`);
    } else {
      log(`  📋 Ashby validation errors: (none detected)`);
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
          const input = await page.$(`[id="${forAttr}"]`);
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
    // Download PDF first
    log(`  📥 Downloading resume...`);
    const tmpPath = require('path').resolve('/tmp', 'aaron_resume.pdf');
    
    // Skip download if cached copy exists from this run
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      const dlController = new AbortController();
      const dlTimeout = setTimeout(() => dlController.abort(), 15000);
      try {
        const response = await fetch(pdfUrl, { signal: dlController.signal });
        clearTimeout(dlTimeout);
        if (!response.ok) { log(`  ⚠ Resume download failed: ${response.status}`); return false; }
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(tmpPath, Buffer.from(buffer));
      } catch(dlErr) {
        clearTimeout(dlTimeout);
        log(`  ⚠ Resume download error: ${dlErr.message.slice(0,40)}`);
        if (!fs.existsSync(tmpPath)) return false;
        log(`  📎 Using cached resume`);
      }
    } else {
      log(`  📎 Using cached resume`);
    }

    // Verify file exists and has content
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      log(`  ⚠ Resume file empty or missing at ${tmpPath}`);
      return false;
    }
    log(`  💾 Resume ready: ${fs.statSync(tmpPath).size} bytes at ${tmpPath}`);

    // Try file input directly first
    for (const sel of selectors) {
      const fileInput = await page.$(sel);
      if (fileInput) {
        log(`  📎 Setting file on input: ${sel}`);
        await fileInput.setInputFiles(tmpPath);
        await page.waitForTimeout(1500);
        log(`  ✅ Resume uploaded via setInputFiles`);
        return true;
      }
    }

    // Fallback: use file chooser event — fully wrapped to prevent crashes
    await (async () => {
      try {
        log(`  📎 Trying file chooser approach...`);
        const fileChooser = await Promise.race([
          page.waitForEvent('filechooser'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
        ]).catch(() => null);
        
        if (!fileChooser) return;
        
        await page.click('input[type="file"], label[for*="resume"]').catch(() => {});
        await fileChooser.setFiles(tmpPath);
        await page.waitForTimeout(1500);
        log(`  ✅ Resume uploaded via file chooser`);
      } catch(fcErr) {
        log(`  ⚠ File chooser skipped: ${fcErr.message.slice(0, 40)}`);
      }
    })();

    log(`  ⚠ No file input found`);
    return false;
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

/**
 * Job Autopilot — Automated Application Submission
 */

const { chromium: vanillaChromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Stealth browser setup — masks automation fingerprints
let stealthChromium;
try {
  const { chromium: extraChromium } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  extraChromium.use(StealthPlugin());
  stealthChromium = extraChromium;
  console.log('[stealth] playwright-extra + stealth plugin loaded');
} catch(e) {
  console.log('[stealth] playwright-extra not available, falling back to rebrowser-playwright');
  try {
    const { chromium: reChromium } = require('rebrowser-playwright');
    stealthChromium = reChromium;
    console.log('[stealth] rebrowser-playwright loaded');
  } catch(e2) {
    console.log('[stealth] no stealth browser available, using vanilla playwright');
    stealthChromium = vanillaChromium;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PROXY_URL = process.env.PROXY_URL || null;
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SUBMISSIONS = 10;
const MIN_SCORE = 75;
const DELAY_BETWEEN_MS = () => 12000 + Math.random() * 8000;

const RESUME_VARIANTS = {
  fintech: null,
  early_stage: null,
  default: null,
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
  website: 'https://frameandreel.com',
  heard_about: 'LinkedIn',
  authorized_to_work: 'Yes',
  requires_sponsorship: 'No',
  salary_expectation: '145000',
};

const FOCUS_ELEMENTS = [
  'Quantitative scale metrics',
  'Cross-functional team execution',
  'Operational framework construction',
  'Revenue efficiency',
];

const MANUAL_COMPANIES = ['Stripe', 'Databricks', 'Block', 'Intuit', 'Waymo'];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const runLog = { started_at: new Date().toISOString(), dry_run: DRY_RUN, results: [] };

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomFocus() { return FOCUS_ELEMENTS[Math.floor(Math.random() * FOCUS_ELEMENTS.length)]; }

// Humanized mouse click — drifts pointer naturally to avoid bot detection
async function humanizedClick(page, elementOrSelector) {
  try {
    const el = typeof elementOrSelector === 'string'
      ? await page.$(elementOrSelector)
      : elementOrSelector;
    if (!el) return false;
    const box = await el.boundingBox();
    if (!box) { await el.click(); return true; }
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(x, y, { steps: 5 });
    await page.waitForTimeout(40 + Math.floor(Math.random() * 60));
    await page.mouse.down();
    await page.waitForTimeout(40 + Math.floor(Math.random() * 60));
    await page.mouse.up();
    return true;
  } catch(e) { return false; }
}

async function main() {
  log(DRY_RUN ? '🔍 DRY RUN mode' : '🚀 Starting job submission run');

  const staleWindow = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { error: rollbackError, count: rollbackCount } = await supabase
    .from('applications')
    .update({ status: 'queued', notes: 'Auto-recovered from stale processing state' })
    .eq('status', 'processing')
    .lt('started_at', staleWindow);
  if (!rollbackError && rollbackCount > 0) log('♻ Recovered ' + rollbackCount + ' stale jobs back to queued');

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
  RESUME_VARIANTS.default = resumeData?.pdf_url || null;
  log(`📄 Resume: ${resumeData?.filename || 'default'}`);

  const browser = await stealthChromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1920,1080',
    ],
  });

  let submitted = 0, failed = 0, manual = 0, skipped = 0, duplicate = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const titleLower = (job.job_title || '').toLowerCase();
    const titleBlacklist = ['security operations', 'incident response', ' soc ', 'v-bat',
      'air vehicle', 'drone operator', 'software engineer', 'backend engineer', 'frontend engineer',
      'devops', 'data scientist', 'machine learning engineer', 'legal counsel', 'attorney',
      'accountant', 'debt collection', 'collections specialist', 'field technician',
      'hardware engineer', 'network engineer', 'technical program manager'];
    if (titleBlacklist.some(t => titleLower.includes(t))) {
      try { await supabase.from('applications').update({ status: 'archived' }).eq('id', job.id); } catch(e) {}
      log(`  ⏭ Archived irrelevant role: ${job.job_title}`);
      continue;
    }

    log(`\n[${i + 1}/${jobs.length}] ${job.job_title} at ${job.company} (${job.ats_type})`);
    log(`  Score: ${job.match_score}% | Variant: ${job.resume_variant || 'default'}`);

    try {
      const check = await fetch(job.url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if ([404, 410].includes(check.status)) {
        log(`  ⚰ Job gone (${check.status}) — archiving`);
        await supabase.from('applications').update({ status: 'archived', notes: `HTTP ${check.status}` }).eq('id', job.id);
        skipped++; continue;
      }
      if ([301, 302].includes(check.status) && job.ats_type === 'lever') {
        const loc = check.headers.get('location') || '';
        if (!loc.includes(job.external_id)) {
          log(`  ⚰ Lever job redirected away — archiving`);
          await supabase.from('applications').update({ status: 'archived', notes: 'Lever 302 redirect' }).eq('id', job.id);
          skipped++; continue;
        }
      }
    } catch (e) { log(`  ⚠ Pre-flight failed: ${e.message} — continuing`); }

    if (DRY_RUN) {
      log('  ⏭ DRY RUN — skipping');
      runLog.results.push({ job_id: job.id, status: 'dry_run' });
      skipped++; continue;
    }

    const { data: claimed } = await supabase
      .from('applications')
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', job.id).eq('status', 'queued').select();

    if (!claimed || claimed.length === 0) { log(`  ⏭ Already claimed — skipping`); skipped++; continue; }

    const variantKey = job.resume_variant || 'default';
    const resumePdfUrl = RESUME_VARIANTS[variantKey] || RESUME_VARIANTS.default;

    const context = await browser.newContext({
      bypassCSP: true,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
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

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    // Block images/fonts/stylesheets to save proxy bandwidth and speed up runs
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['image', 'media', 'font'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

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
        log(`  ♻ ${result.message}`); duplicate++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'duplicate' });
      } else if (result.manual) {
        await supabase.from('applications').update({ status: 'manual', notes: result.message }).eq('id', job.id);
        log(`  📋 Manual: ${result.message}`); manual++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'manual' });
      } else if (result.success) {
        await supabase.from('applications').update({ status: 'submitted', submission_time: Math.floor(Date.now() / 1000), notes: result.message }).eq('id', job.id);
        log(`  ✅ ${result.message}`); submitted++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'submitted' });
      } else {
        await supabase.from('applications').update({ status: 'failed', notes: result.message }).eq('id', job.id);
        log(`  ❌ ${result.message}`); failed++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'failed', message: result.message });
      }
    } catch (err) {
      log(`  💥 Exception: ${err.message}`);
      await page.screenshot({ path: `/tmp/error-${job.id}.png`, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      if (html) fs.writeFileSync(`/tmp/debug-error-${job.id}.html`, html.slice(0, 50000));
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

async function pollForSecurityCode() {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    log('  ⚠ Gmail credentials not configured for security code polling');
    return null;
  }
  try {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const startTime = Date.now();
    while (Date.now() - startTime < 60000) {
      try {
        const dayTimestamp = Math.floor(Date.now() / 86400000) * 86400;
        const res = await gmail.users.messages.list({ userId: 'me', q: `from:no-reply@us.greenhouse-mail.io after:${dayTimestamp}`, maxResults: 10 });
        if (res.data.messages && res.data.messages.length > 0) {
          for (const msg of res.data.messages) {
            const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
            const internalDate = parseInt(full.data.internalDate || '0', 10);
            if (internalDate < Date.now() - 600000) continue;
            const snippet = full.data.snippet || '';
            const bodyData = full.data.payload?.body?.data || full.data.payload?.parts?.[0]?.body?.data || '';
            const bodyText = bodyData ? Buffer.from(bodyData, 'base64').toString() : '';
            const fullText = snippet + ' ' + bodyText;
            const codeMatch = fullText.match(/([a-zA-Z0-9]{8})/g);
            if (codeMatch) {
              const commonWords = ['security','passcode','confirm','complete','required','provided','yourself','november','december','january','february','application','submitted','greenhouse'];
              const code = codeMatch.find(c => !commonWords.includes(c.toLowerCase()));
              if (code) { log('  ✅ Found security code in Gmail: ' + code); return code; }
            }
          }
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch(e) { log('  ⚠ Gmail polling error: ' + e.message); }
  return null;
}

function getDropdownAnswer(labelText) {
  const c = labelText.toLowerCase();
  if (c.includes('sponsor') || c.includes('visa') || c.includes('immigration') ||
      c.includes('work authorization') || c.includes('future re') ||
      c.includes('work permit') || c.includes('right to work support') ||
      c.includes('additional right to work')) return 'No';
  if (c.includes('authorized') || c.includes('eligible to work') ||
      c.includes('legally') || c.includes('right to work')) return 'Yes';
  if (c.includes('non-compete') || c.includes('non compete') ||
      c.includes('non-solicit') || c.includes('agreement with') ||
      c.includes('former employer')) return 'No';
  if (c.includes('hybrid') || c.includes('in-office') || c.includes('in office') ||
      c.includes('in-person') || c.includes('relocat') || c.includes('willing to work') ||
      c.includes('commit to being')) return 'Yes';
  if (c.includes('previously worked') || c.includes('worked for') ||
      c.includes('formerly') || c.includes('ever worked') ||
      c.includes('currently work for') || c.includes('do you work for') ||
      c.includes('former employee') || c.includes('conflict of interest')) return 'No';
  if (c.includes('state of residence') || c.includes('current state') || c.includes('province')) return 'California';
  if (c.includes('metro') || c.includes('san francisco bay') || c.includes('based in sf') || c.includes('based in san francisco')) return 'San Francisco Bay';
  if (c.includes('veteran')) return 'I am not a protected veteran';
  if (c.includes('disability')) return 'No, I do not have a disability';
  if (c.includes('gender') || c.includes('race') || c.includes('ethnicity') ||
      c.includes('ethnic') || c.includes('sexual orientation') || c.includes('lgbtq') ||
      c.includes('transgender') || c.includes('identify as') || c.includes('identify my') ||
      c.includes('lgbtqia') || c.includes('pronoun')) return 'Decline';
  if (c.includes('school') || c.includes('university') || c.includes('college') || c.includes('institution')) return 'Georgetown University';
  if (c.includes('degree') || c.includes('level of education') || c.includes('highest.*degree') || c.includes('degree.*obtained')) return "Master's";
  if (c.includes('discipline') || c.includes('field of study') || c.includes('major') || c.includes('area of study')) return 'European Studies';
  if (c.includes('graduation') || c.includes('grad year') || c.includes('year.*degree')) return '2015';
  if (c.includes('ai policy') || c.includes('artificial intelligence policy') || c.includes('use of ai') || c.includes('ai tool') || c.includes('used ai')) return 'No';
  if (c.includes('m&a') || c.includes('merger') || c.includes('acquisition') || c.includes('deal process') || c.includes('negotiating')) return 'No';
  if (c.includes('first-generation') || c.includes('first generation professional')) return 'Decline';
  if (c.includes('hear about') || c.includes('how did you') || c.includes('source') || c.includes('referred')) return 'LinkedIn';
  if (c.includes('sql') || c.includes('advanced knowledge')) return 'Yes';
  if (c.includes('ai tool') || c.includes('artificial intelligence')) return 'Yes';
  if (c.includes('do you') || c.includes('are you') || c.includes('can you') || c.includes('will you') || c.includes('have you')) return 'Yes';
  return null;
}

async function submitGreenhouse(page, job, resumeText, resumePdfUrl, focus) {
  try {
    const jobId = job.external_id;
    const slug = job.ats_slug;
    const applyUrl = `https://boards.greenhouse.io/${slug}/jobs/${jobId}?gh_jid=${jobId}#app`;
    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'load', timeout: 30000 });
    try {
      await page.waitForSelector('#application_form, #app, #first_name, input[id="first_name"]', { state: 'visible', timeout: 12000 });
      await page.waitForTimeout(1500);
    } catch (e) { log('  ⚠ Form not found after 12s'); }

    const finalUrl = page.url();
    const finalDomain = new URL(finalUrl).hostname;
    if (!finalDomain.includes('greenhouse.io')) {
      const knownCustomSites = ['fivetran.com','airbnb.com','okta.com','lyft.com','pinterestcareers.com','careerpuck.com','samsara.com','databricks.com'];
      if (knownCustomSites.some(s => finalDomain.includes(s))) {
        try { await supabase.from('companies').update({ active: false, notes: 'custom career site' }).eq('ats_slug', job.ats_slug); } catch(e) {}
      }
      return { success: false, manual: true, message: `Custom site: ${finalDomain}` };
    }

    const debugHtml = await page.content();
    fs.writeFileSync(`/tmp/debug-greenhouse-${Date.now()}.html`, debugHtml.slice(0, 100000));

    const formExists = await page.$('form, #application-form, .application-form, #main_fields');
    if (!formExists) return { success: false, message: `No form found at ${finalUrl}` };

    const ghCaptcha = await page.$('#g-recaptcha, .g-recaptcha, #h-captcha, .h-captcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').catch(() => null);
    if (ghCaptcha) { log('  ⚠ CAPTCHA detected'); return { success: false, manual: true, message: 'CAPTCHA wall detected' }; }

    await humanType(page, '#first_name', PROFILE.first_name);
    await humanType(page, '#last_name', PROFILE.last_name);
    await humanType(page, '#preferred_name', PROFILE.first_name);
    await humanType(page, '#email', PROFILE.email);
    await humanType(page, '#phone', PROFILE.phone_formatted);

    try {
      const locField = await page.$('#candidate-location, #job_application_location');
      if (locField) {
        await locField.click(); await locField.fill(''); await page.waitForTimeout(300);
        await locField.type(PROFILE.city, { delay: 50 }); await page.waitForTimeout(800);
        await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300);
        await page.keyboard.press('Enter'); await page.waitForTimeout(300);
      }
    } catch (e) { log(`  ⚠ Location: ${e.message}`); }

    try {
      const countryField = await page.$('#country, input[id*="country" i]');
      if (countryField) {
        await countryField.click(); await countryField.fill(''); await page.waitForTimeout(300);
        await countryField.type('United States', { delay: 50 }); await page.waitForTimeout(1000);
        await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300);
        await page.keyboard.press('Enter'); await page.waitForTimeout(500);
      } else {
        const countrySelect = await page.$('select[id*="country" i]');
        if (countrySelect) await countrySelect.selectOption({ label: 'United States' }).catch(() => countrySelect.selectOption({ value: 'US' }).catch(() => {}));
      }
    } catch (e) { log(`  ⚠ Country: ${e.message}`); }

    for (const sel of ['input[name*="linkedin" i]','input[id*="linkedin" i]','input[placeholder*="linkedin" i]','input[id*="LinkedIn"]','[id="question_linkedin"]']) {
      if (await humanType(page, sel, PROFILE.linkedin)) break;
    }
    for (const sel of ['input[name*="website" i]','input[id*="website" i]']) {
      if (await humanType(page, sel, PROFILE.website)) break;
    }

    try {
      const coverLetterInput = await page.$('input[type="file"][id="cover_letter"]');
      if (coverLetterInput) {
        const clPath = '/tmp/aaron_cover_letter.txt';
        fs.writeFileSync(clPath, `Dear Hiring Manager,\n\nI am excited to apply for this role. With 10+ years in strategy and operations — including leading a $200M portfolio consolidation at Enova International and scaling Product School from $2M to $6M in revenue — I bring a proven track record of driving operational excellence and business growth.\n\nBest regards,\nAaron Filous\nfilousaaron@gmail.com | (650) 291-3142`);
        await coverLetterInput.setInputFiles(clPath);
        log('  📎 Cover letter uploaded');
      }
    } catch(e) {}

    let resumeUploaded = false;
    if (resumePdfUrl) {
      resumeUploaded = await uploadResumePdf(page, resumePdfUrl, [
        'input[type="file"][id="resume"]','input[type="file"][id="resume_file"]',
        'input[type="file"][name="job_application[resume]"]','input[type="file"][accept*="pdf"]','input[type="file"]',
      ]);
      if (resumeUploaded) log(`  📎 Resume PDF uploaded`);
    }

    const resumeTextFilled = await fillField(page, ['#resume_text','textarea[name="job_application[resume_text]"]','textarea[id*="resume"]'], resumeText.slice(0, 5000));
    if (resumeTextFilled) log(`  📝 Resume text filled`);

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));
    await handleRadioByText(page, /authorized.*work|work.*authorized|eligible.*work/i, /^Yes$/i);
    await handleRadioByText(page, /require.*sponsorship|visa sponsor|need.*sponsor/i, /^No$/i);

    try {
      const allFields = await page.$$('div.field, div[class*="field"]');
      for (const field of allFields) {
        const fieldText = (await field.textContent() || '').toLowerCase();
        if (/willing|authorized|legally|currently.*us|relocate|in.person|on.?site/i.test(fieldText)) {
          const labels = await field.$$('label');
          for (const label of labels) {
            const lt = (await label.textContent() || '').toLowerCase().trim();
            if (lt === 'yes' || lt === 'true' || lt === 'i am' || lt === 'willing') { await label.click(); break; }
          }
        }
        if (/sponsorship|visa|sponsor/i.test(fieldText)) {
          const labels = await field.$$('label');
          for (const label of labels) {
            const lt = (await label.textContent() || '').toLowerCase().trim();
            if (lt === 'no' || lt === 'false' || lt === 'i do not') { await label.click(); break; }
          }
        }
      }
    } catch(e) {}

    await handleDropdownByText(page, /authorized.*work|work.*authorized/i, 'Yes');
    await handleDropdownByText(page, /require.*sponsorship|visa/i, 'No');

    try {
      const heardSel = await page.$('select[name*="referral" i], select[id*="heard" i]');
      if (heardSel) await heardSel.selectOption({ label: 'LinkedIn' }).catch(() => {});
    } catch (e) {}

    try {
      const allLabels = await page.$$('label');
      for (const label of allLabels) {
        const rawLabel = (await label.textContent() || '');
        const labelText = rawLabel.toLowerCase();
        const forAttr = await label.getAttribute('for');
        if (!forAttr) continue;
        if (forAttr.startsWith('question_') || /^\d/.test(forAttr)) {
          const el = await page.$(`[id="${forAttr}"]`);
          if (!el) continue;
          const tag = await el.evaluate(e => e.tagName.toLowerCase());
          const inputType = await el.evaluate(e => e.type || '');
          if (tag === 'select') {
            const answer = getDropdownAnswer(rawLabel) || null;
            if (answer) {
              await el.selectOption({ label: answer }).catch(() => el.selectOption({ label: answer + ' to self-identify' }).catch(() => el.selectOption({ value: answer.toLowerCase() }).catch(() => el.selectOption({ index: 1 }).catch(() => {}))));
            } else { await el.selectOption({ index: 1 }).catch(() => {}); }
          } else if (tag === 'textarea' || (tag === 'input' && !['file','hidden','radio','checkbox'].includes(inputType))) {
            const isHiddenBacking = await page.evaluate((id) => {
              const el = document.getElementById(id);
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (style.opacity === '0' || parseFloat(style.opacity) < 0.1) return true;
              if (style.position === 'absolute' && (style.zIndex === '-1' || parseInt(style.zIndex) < 0)) return true;
              if (style.visibility === 'hidden') return true;
              const siblings = el.parentElement ? [...el.parentElement.children] : [];
              return siblings.some(s => s !== el && (s.getAttribute('role') === 'combobox' || (s.className && typeof s.className === 'string' && (s.className.includes('css-') || s.className.includes('select') || s.className.includes('Select')))));
            }, forAttr).catch(() => false);
            const dropdownAnswer = getDropdownAnswer(rawLabel);
            if (isHiddenBacking || (dropdownAnswer !== null && inputType === 'text')) {
              const answer = dropdownAnswer;
              if (answer !== null) {
                try {
                  const fieldContainer = await label.evaluateHandle(el => {
                    let p = el.parentElement;
                    for (let i = 0; i < 6; i++) {
                      if (!p) break;
                      const cls = (p.className || '').toString();
                      if (cls.includes('field') || cls.includes('Field') || p.tagName === 'LI' || p.tagName === 'SECTION' || (p.children.length > 1 && p.querySelector('label'))) return p;
                      p = p.parentElement;
                    }
                    return el.parentElement;
                  });
                  const trigger = await fieldContainer.$('[class*="css-"][class*="container"], [class*="css-"][class*="control"], [role="combobox"], div[class*="Select"], div[class*="select__control"], .select2-choice, .select2-container, .select2-selection').catch(() => null);
                  if (trigger) {
                    try {
                      const hiddenSelect = await fieldContainer.$('select');
                      if (hiddenSelect) {
                        const opts = await hiddenSelect.$$eval('option', os => os.map(o => o.textContent.trim()));
                        const match = opts.find(o => {
                          const ol = o.toLowerCase();
                          return ol.includes(answer.toLowerCase()) ||
                            (answer === 'No' && (ol === 'no' || ol.startsWith('no,'))) ||
                            (answer === 'Yes' && (ol === 'yes' || ol.startsWith('yes,'))) ||
                            (answer === 'Decline' && ol.includes('decline')) ||
                            (answer === 'I am not a protected veteran' && ol.includes('not a protected')) ||
                            (answer === 'No, I do not have a disability' && ol.includes('do not have'));
                        });
                        if (match) {
                          await hiddenSelect.selectOption({ label: match });
                          await hiddenSelect.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
                          continue;
                        }
                      }
                    } catch(nsErr) {}
                    const triggerVisible = await trigger.isVisible().catch(() => false);
                    if (triggerVisible) {
                      await trigger.scrollIntoViewIfNeeded();
                      await trigger.click({ timeout: 3000, force: true });
                      await page.waitForTimeout(600);
                      const innerInput = await trigger.$('input[type="text"], input[role="combobox"]').catch(() => null);
                      if (innerInput && await innerInput.isVisible().catch(() => false)) {
                        await innerInput.fill(answer); await page.waitForTimeout(500);
                        const kbOpts = await page.$$('[role="option"]');
                        let kbPicked = false;
                        for (const opt of kbOpts) {
                          const t = (await opt.innerText().catch(() => '')).toLowerCase();
                          if (t.includes(answer.toLowerCase().slice(0, 15))) { await opt.click({ timeout: 1500 }); kbPicked = true; break; }
                        }
                        if (!kbPicked) await page.keyboard.press('Enter').catch(() => {});
                        if (kbPicked) continue;
                      }
                      const answer_lower = answer.toLowerCase();
                      const options = await page.$$('[role="option"], [class*="option"], ul[role="listbox"] li');
                      let picked = false;
                      for (const opt of options) {
                        const optText = (await opt.innerText().catch(() => '')).toLowerCase().trim();
                        if (optText.includes(answer_lower) || answer_lower.includes(optText.slice(0, 20)) ||
                            (answer === 'Decline' && (optText.includes('decline') || optText.includes('not wish') || optText.includes('prefer not') || optText.includes('choose not'))) ||
                            (answer === 'No' && (optText === 'no' || optText.startsWith('no,') || optText.startsWith('no '))) ||
                            (answer === 'Yes' && (optText === 'yes' || optText.startsWith('yes,') || optText.startsWith('yes '))) ||
                            (answer === 'California' && optText.includes('california')) ||
                            (answer === 'San Francisco Bay' && optText.includes('san francisco')) ||
                            (answer === 'LinkedIn' && optText.includes('linkedin')) ||
                            (answer === 'I am not a protected veteran' && (optText.includes('not a protected') || optText.includes('not a veteran') || optText.includes('i am not'))) ||
                            (answer === 'No, I do not have a disability' && (optText.includes('do not have') || optText.includes('no disability') || optText.startsWith('no, i')))) {
                          await opt.click({ timeout: 1500 }); picked = true; break;
                        }
                      }
                      if (!picked && options.length > 0) {
                        for (const opt of options) {
                          const optText = (await opt.innerText().catch(() => '')).trim();
                          if (optText && !optText.toLowerCase().includes('select') && !optText.toLowerCase().includes('not in the us') && !optText.toLowerCase().includes('choose')) {
                            await opt.click({ timeout: 1500 }); picked = true; break;
                          }
                        }
                      }
                      await page.waitForTimeout(200);
                    }
                  } else {
                    try {
                      await el.click({ timeout: 2000 }); await page.waitForTimeout(400);
                      const options = await page.$$('[role="option"]');
                      for (const opt of options) {
                        const optText = (await opt.innerText().catch(() => '')).toLowerCase().trim();
                        if (optText.includes(answer.toLowerCase())) { await opt.click({ timeout: 1500 }); break; }
                      }
                    } catch(ce) {}
                  }
                } catch(e) {}
              }
            } else {
              let answer = null;
              const lt = labelText.toLowerCase();
              if (/linkedin/i.test(lt)) answer = PROFILE.linkedin;
              else if (/website|portfolio|personal site/i.test(lt)) answer = PROFILE.website;
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
              else if (/school|university|college|institution/i.test(lt)) answer = 'Georgetown University';
              else if (/degree|level of education/i.test(lt)) answer = "Master's";
              else if (/discipline|field of study|major|area of study/i.test(lt)) answer = 'European Studies';
              else if (/gpa/i.test(lt)) answer = '3.7';
              else if (/graduation|grad.*year|year.*grad/i.test(lt)) answer = '2015';
              else if (/company|employer|recent.*company|current.*company/i.test(lt)) answer = 'Stealth Startup';
              else if (/title|position|role.*current|current.*role/i.test(lt)) answer = 'Strategy & Operations Lead';
              else if (/salary|compensation|pay expectation|desired.*pay/i.test(lt)) answer = '145000';
              else if (/years.*experience|experience.*years/i.test(lt)) answer = '10';
              else if (/start.*date|available|earliest.*start/i.test(lt)) answer = 'Immediately';
              else if (/why.*work|why.*join|why.*interest|what excites|what draws/i.test(lt)) answer = 'I am excited to apply my 10+ years of strategy and operations experience. At Enova International I led cross-functional initiatives including a $200M portfolio consolidation and drove a 200% increase in SDR productivity.';
              else if (/why.*you|what makes you|what.*qualif|fit for this/i.test(lt)) answer = 'My background spans strategy, operations, and cross-functional leadership at Enova International, Product School, App Academy, and Promotable. I consistently translate complex problems into scalable operational systems.';
              else if (/experience|background|describe|tell us about/i.test(lt)) answer = 'My background spans 10+ years in strategy and operations roles. At Enova International I led a $200M portfolio consolidation, built SDR operations from the ground up, and drove cross-functional alignment across product, finance, and go-to-market teams.';
              else if (/sql/i.test(lt)) answer = 'Yes, I have advanced SQL skills including complex joins, window functions, and query optimization.';
              else if (/cover.*letter|additional.*info|anything.*else|other.*information/i.test(lt)) answer = 'Please see my attached cover letter and resume for additional details.';
              else if (/hear.*about|how.*find|source|referred/i.test(lt)) answer = 'LinkedIn';
              else if (/familiar.*with|how familiar/i.test(lt)) answer = 'Somewhat familiar';
              else if (/acknowledge|confirm|agree|certify/i.test(lt)) answer = 'Yes';
              else if (/first.*gen|generation/i.test(lt)) answer = 'Yes';
              else {
                const responses = job.generated_responses || {};
                const companyName = (job.company || '').toLowerCase();
                for (const [q, a] of Object.entries(responses)) {
                  if (lt.includes(q.toLowerCase().slice(0, 20))) {
                    const aStr = String(a).toLowerCase();
                    const mentionsWrongCompany = ['anthropic','faire','intercom','figma','affirm','gusto','chime','verkada','mixpanel','amplitude','wonderschool','loop','waymo','ramp'].some(c => c !== companyName && aStr.includes(c));
                    if (!mentionsWrongCompany) { answer = String(a); break; }
                  }
                }
                if (!answer) answer = 'Please see my attached resume for details.';
              }
              await el.fill((answer || '').slice(0, 500));
            }
          }
        }
      }
    } catch (e) { log('  ⚠ Form handler error: ' + e.message); }

    try {
      const eeocLabels = await page.$$('label');
      for (const lbl of eeocLabels) {
        const lblText = (await lbl.textContent().catch(() => '')).toLowerCase().trim();
        if (!lblText || !/gender|race|ethnic|sexual orient|disability|veteran|lgbtq|pronoun|transgender/.test(lblText)) continue;
        const forAttr = await lbl.getAttribute('for');
        if (!forAttr) continue;
        const container = await lbl.evaluateHandle(el => { let p = el.parentElement; for (let i = 0; i < 5; i++) { if (!p) break; if (p.children.length > 1) return p; p = p.parentElement; } return el.parentElement; });
        const trigger = await container.$('[class*="css-"][class*="control"], [class*="css-"][class*="container"], [role="combobox"]').catch(() => null);
        if (trigger && await trigger.isVisible().catch(() => false)) {
          await trigger.click({ timeout: 2000, force: true }); await page.waitForTimeout(600);
          const options = await page.$$('[role="option"]');
          let picked = false;
          for (const opt of options) {
            const t = (await opt.innerText().catch(() => '')).toLowerCase();
            if (t.includes('decline') || t.includes('not wish') || t.includes('prefer not') || t.includes('choose not') || t.includes('do not have') || t.includes('not a protected')) {
              await opt.click({ timeout: 1500 }); picked = true; break;
            }
          }
          if (!picked && options.length > 0) { await options[options.length - 1].click({ timeout: 1500 }).catch(() => {}); }
          await page.waitForTimeout(300);
        }
      }
    } catch(e) {}

    for (const eeocField of ['gender','hispanic_ethnicity','veteran_status','disability_status']) {
      try {
        const el = await page.$(`[id="${eeocField}"]`);
        if (!el) continue;
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        if (tag === 'select') { await el.selectOption({ index: 1 }).catch(() => {}); }
        else {
          await el.click().catch(() => {}); await page.waitForTimeout(400);
          const options = await page.$$('[role="option"], ul li, [class*="option"]');
          for (const opt of options) {
            const t = (await opt.innerText().catch(() => '')).toLowerCase();
            if (t.includes('decline') || t.includes('not wish') || t.includes('prefer not') || t.includes('not a protected') || t.includes('do not have')) { await opt.click(); break; }
          }
          await page.waitForTimeout(300);
        }
      } catch(e) {}
    }

    try {
      const allLabels = await page.$$('label');
      for (const label of allLabels) {
        const text = (await label.innerText() || '').toLowerCase();
        if (text.includes('decline to self-identify') || text.includes('i do not wish to answer') || text.includes('prefer not to say') || text.includes('decline to identify')) await label.click();
      }
    } catch(e) {}

    const submitBtn = page.locator('#submit_app, input[type="submit"][value*="Submit" i], button[type="submit"]').first();
    if (await submitBtn.count() === 0) return { success: false, message: 'Submit button not found' };

    const successPromise = Promise.any([
      page.waitForRequest(req => req.url().includes(`/v1/boards/${slug}/jobs/${jobId}/application`) && req.method() === 'POST', { timeout: 15000 }),
      page.waitForNavigation({ url: u => u.includes('confirmation'), waitUntil: 'domcontentloaded', timeout: 15000 }),
    ]).catch(() => null);

    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));
    await humanizedClick(page, await submitBtn.elementHandle());
    log(`  🖱 Submitting...`);

    const result = await successPromise;
    const afterUrl = page.url();
    const pageText = await page.textContent('body').catch(() => '');

    if (pageText.match(/already applied|already submitted|previously applied/i)) return { duplicate: true, message: 'Already applied' };
    if (result) {
      const resultUrl = typeof result.url === 'function' ? result.url() : afterUrl;
      return { success: true, message: resultUrl.includes('confirmation') ? 'Submitted via Greenhouse ✓ (confirmed)' : 'Submitted via Greenhouse ✓ (POST intercepted)' };
    }
    if (pageText.match(/thank you|application received|we received/i)) return { success: true, message: 'Submitted via Greenhouse ✓ (DOM)' };
    if (afterUrl.includes('confirmation')) return { success: true, message: 'Submitted via Greenhouse ✓ (URL)' };

    try {
      const securityInput = page.locator('input[id*="verification"], input[id*="security"], input[name*="code"], input[placeholder*="code" i]');
      if (await securityInput.count() > 0 && await securityInput.isVisible().catch(() => false)) {
        log('  🔒 Security code gate — polling Gmail...');
        const code = await pollForSecurityCode();
        if (code) {
          await securityInput.fill(code); await page.waitForTimeout(500);
          const resubmitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
          if (await resubmitBtn.count() > 0) await resubmitBtn.click();
          await page.waitForTimeout(3000);
        }
      }
    } catch(se) {}

    const validationErrors = await page.evaluate(() => {
      const errors = document.querySelectorAll('.error, .field-error, [class*="error"], [class*="invalid"]');
      return [...errors].map(el => el.textContent?.trim()).filter(t => t && t.length > 0).slice(0, 10);
    }).catch(() => []);
    if (validationErrors.length > 0) {
      log(`  📋 Validation errors: ${validationErrors.join(' | ')}`);
      return { success: false, message: `Validation: ${validationErrors.slice(0, 3).join(', ')}` };
    }

    await page.screenshot({ path: '/tmp/greenhouse-debug.png', fullPage: true }).catch(() => {});
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
    if (!finalDomain.includes('lever.co')) return { success: false, manual: true, message: `Custom site: ${finalDomain}` };

    if (resumePdfUrl) {
      await uploadResumePdf(page, resumePdfUrl, ['input[type="file"][id="resume_file"]','input[type="file"]']);
      log(`  📎 Resume uploaded — waiting for parse...`);
      try {
        await Promise.race([
          page.waitForFunction(() => { const n = document.querySelector('input[name="name"]'); return n && n.value && n.value.length > 1; }, { timeout: 12000 }),
          new Promise(resolve => setTimeout(() => { log('  ⚠ Resume parse timeout — moving forward'); resolve(); }, 12000)),
        ]);
      } catch(e) { log('  ⚠ Resume parse wait: ' + e.message.slice(0, 40)); }
    }

    const nameFilled = await clearAndType(page, 'input[name="name"]', PROFILE.full_name);
    const emailFilled = await clearAndType(page, 'input[name="email"]', PROFILE.email);
    const phoneFilled = await clearAndType(page, 'input[name="phone"]', PROFILE.phone_formatted);
    log(`  📝 Lever fields: name=${nameFilled} email=${emailFilled} phone=${phoneFilled}`);

    await clearAndType(page, 'input[name="urls[LinkedIn]"]', PROFILE.linkedin);
    await clearAndType(page, 'input[name="org"]', 'Stealth Startup').catch(() => {});
    await clearAndType(page, 'input[name="location"]', 'San Mateo, CA').catch(() => {});

    const questionBlocks = await page.$$('.application-question, [data-qa="additional-cards"] .card, .cards-app-item');
    for (const block of questionBlocks) {
      const blockText = (await block.textContent().catch(() => '')).toLowerCase();
      if (/sponsorship|visa sponsor|require.*sponsor/.test(blockText)) {
        const sel = await block.$('select, [role="combobox"]');
        if (sel) {
          await sel.selectOption({ label: 'No' }).catch(async () => {
            await sel.click().catch(() => {}); await new Promise(r => setTimeout(r, 400));
            const noOpt = await page.$('[role="option"]:has-text("No")');
            if (noOpt) await noOpt.click().catch(() => {});
          });
        }
        const noRadio = await block.$('input[value="No"], label:has-text("No")');
        if (noRadio) await noRadio.click().catch(() => {});
      }
      if (/how did you hear|hear about us/.test(blockText)) {
        const sel = await block.$('select, [role="combobox"]');
        if (sel) {
          await sel.selectOption({ label: 'LinkedIn' }).catch(async () => {
            await sel.click().catch(() => {}); await new Promise(r => setTimeout(r, 400));
            const opt = await page.$('[role="option"]:has-text("LinkedIn")');
            if (opt) await opt.click().catch(() => {});
            else { const other = await page.$('[role="option"]:has-text("Other")'); if (other) await other.click().catch(() => {}); }
          });
        }
      }
      if (/authorized.*work|work.*authorized|eligible.*work/.test(blockText)) {
        const yes = await block.$('input[value="Yes"], label:has-text("Yes")');
        if (yes) await yes.click().catch(() => {});
      }
      if (/pronoun/.test(blockText)) {
        const he = await block.$('label:has-text("He/him"), input[value*="he"]');
        if (he) await he.click().catch(() => {});
      }
      if (/export.*control|citizen.*country/.test(blockText)) {
        const ti = await block.$('input[type="text"], textarea');
        if (ti) { await ti.click().catch(() => {}); await ti.type('United States citizen', { delay: 50 + Math.floor(Math.random() * 50) }).catch(() => {}); }
      }
      if (/preferred.*name|preferred first/.test(blockText)) {
        const ti = await block.$('input[type="text"]');
        if (ti && await ti.isVisible().catch(() => false)) { const v = await ti.inputValue().catch(() => ''); if (!v) await ti.type(PROFILE.first_name, { delay: 50 }).catch(() => {}); }
      }
    }

    const answers = job.generated_responses || {};
    for (const [question, answer] of Object.entries(answers)) await tryFillByLabel(page, question, String(answer));

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));

    const jobId = job.external_id;
    const slug = job.ats_slug;
    const leverPromise = Promise.any([
      page.waitForResponse(res => res.url().includes(`/v1/postings/${slug}/${jobId}/apply`) && res.status() === 200, { timeout: 15000 }),
      page.waitForNavigation({ url: u => u.includes('/thanks'), waitUntil: 'domcontentloaded', timeout: 15000 }),
    ]).catch(() => null);

    const captcha = await page.$('#h-captcha, .h-captcha, iframe[src*="hcaptcha"], iframe[src*="recaptcha"]').catch(() => null);
    if (captcha) { log('  ⚠ CAPTCHA detected'); return { success: false, manual: true, message: 'CAPTCHA wall detected' }; }

    let leverSubmitted = false;
    for (const sel of ['button[data-qa="btn-submit"]','.lever-button-black[type="submit"]','button[type="submit"]','input[type="submit"]','button:has-text("Submit Application")','button:has-text("Apply")']) {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded();
        await humanizedClick(page, btn);
        log(`  🖱 Lever submit clicked: ${sel}`); leverSubmitted = true; break;
      }
    }
    if (!leverSubmitted) log('  ⚠ No Lever submit button found');

    const leverResult = await leverPromise;
    const leverUrl = page.url();
    const leverText = await page.textContent('body').catch(() => '');
    log(`  📍 ${leverUrl}`);

    if (leverResult || leverUrl.includes('/thanks')) return { success: true, message: 'Submitted via Lever ✓' };
    if (leverText.match(/application submitted!|your application has been received|thank you for applying/i)) return { success: true, message: 'Submitted via Lever ✓ (DOM)' };

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
    if (!finalDomain.includes('ashbyhq.com')) return { success: false, manual: true, message: `Custom site: ${finalDomain}` };

    log('  📝 Filling Ashby form fields...');

    const ESSAY_ANSWER = "I am most proud of building Promotable from scratch to $40k/month in revenue, selected as an education partner by 1871 Chicago's top tech incubator. I identified a gap in data skills training, built an automated omnichannel sales funnel, and converted a B2C audience to enterprise clients including McDonald's and City Colleges of Chicago.";

    try {
      const formInputs = await page.$$('input, textarea, [contenteditable="true"]');
      for (const input of formInputs) {
        try {
          const isVisible = await input.isVisible().catch(() => false);
          if (!isVisible) continue;
          const inputType = await input.getAttribute('type').catch(() => '');
          if (['file','hidden','submit','checkbox','radio'].includes(inputType)) continue;
          const inputId = await input.getAttribute('id').catch(() => '') || '';
          const inputName = await input.getAttribute('name').catch(() => '') || '';
          const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}/i;
          if (uuidPattern.test(inputId) || uuidPattern.test(inputName)) { log('  ⚠ UUID honeypot skipped: ' + inputId.slice(0, 20)); continue; }

          if (inputId === '_systemfield_phone' || inputName === '_systemfield_phone') {
            await input.focus(); await input.click({ clickCount: 3 });
            await page.keyboard.type(PROFILE.phone_formatted, { delay: 40 });
            const v = await input.evaluate(el => el.value).catch(() => '');
            if (!v) { await input.fill(PROFILE.phone_formatted); await input.evaluate(e => { e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }); }
            log('  ✓ System phone: ' + (await input.evaluate(el => el.value).catch(() => '?'))); continue;
          }
          if (inputId === '_systemfield_linkedin' || inputName === '_systemfield_linkedin') {
            await input.focus(); await input.click({ clickCount: 3 });
            await page.keyboard.type(PROFILE.linkedin, { delay: 40 });
            const v = await input.evaluate(el => el.value).catch(() => '');
            if (!v) { await input.fill(PROFILE.linkedin); await input.evaluate(e => { e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }); }
            log('  ✓ System LinkedIn'); continue;
          }

          const isHoneypot = await input.evaluate(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.width < 5 || r.height < 5) return true;
            const s = window.getComputedStyle(el);
            return s.opacity === '0' || s.display === 'none' || s.visibility === 'hidden';
          }).catch(() => false);
          if (isHoneypot) continue;

          const meta = await input.evaluate(el => {
            const parent = el.closest('[class*="field"],[class*="form"],label,li,div') || el.parentElement;
            const labelEl = document.querySelector(`label[for="${el.id}"]`);
            return [el.getAttribute('placeholder')||'',el.getAttribute('aria-label')||'',el.getAttribute('name')||'',el.getAttribute('id')||'',labelEl?.innerText||'',parent?.innerText?.slice(0,100)||''].join(' ').toLowerCase();
          }).catch(() => '');

          const currentVal = await input.evaluate(el => el.value || '').catch(() => '');
          let fillVal = null;

          if (/\bfull.?name\b/.test(meta) || (/\bname\b/.test(meta) && !meta.includes('company') && !meta.includes('employer') && !meta.includes('file') && !meta.includes('school') && !meta.includes('hear') && meta.length < 200)) {
            fillVal = meta.includes('first') ? PROFILE.first_name : meta.includes('last') ? PROFILE.last_name : PROFILE.full_name;
          }
          else if (/\bemail\b/.test(meta) && meta.length < 200) fillVal = PROFILE.email;
          else if (/\bphone\b|\btel\b|phone number/.test(meta) && meta.length < 200) fillVal = PROFILE.phone_formatted;
          else if (/linkedin/.test(meta)) { const li = PROFILE.linkedin; fillVal = li.startsWith('http') ? li : 'https://' + li; }
          else if (/\bwebsite\b|\bportfolio\b/.test(meta)) fillVal = PROFILE.website;
          else if (/how did you hear|where did you hear|referral source/.test(meta)) fillVal = 'LinkedIn';
          else if (/country.*reside|country.*currently|currently.*reside/.test(meta)) fillVal = 'United States';
          else if (/country/.test(meta) && meta.length < 100) fillVal = 'United States';
          else if (/require.*sponsor|sponsor.*work|visa.*sponsor/.test(meta)) fillVal = 'No';
          else if (/legal.*permanent.*resid|permanent.*resid.*countries/.test(meta)) fillVal = 'United States';
          else if (/your pronouns|pronouns/.test(meta)) fillVal = 'He/Him';
          else if (/legal.*first.*last|legal.*name|full.*legal/.test(meta)) fillVal = PROFILE.full_name;
          else if (/preferred.*first|first.*preferred/.test(meta)) fillVal = PROFILE.first_name;
          else if (/preferred.*last|last.*preferred/.test(meta)) fillVal = PROFILE.last_name;
          else if (/current.*employer|most recent.*employer/.test(meta)) fillVal = 'Stealth Startup';
          else if (/location/.test(meta) && meta.length < 80) fillVal = 'San Mateo, CA';
          else if (/current.*company|most recent.*company/.test(meta)) fillVal = 'Stealth Startup';
          else if (/proud of|exceptional performance|something you/.test(meta)) fillVal = ESSAY_ANSWER;
          else if (/what excites you|why.*want.*work|why do you want|why.*company|why.*role|why.*join|why.*interest|most excit|drawn to/.test(meta)) fillVal = 'I am excited by the opportunity to apply my 10+ years of strategy and operations experience. At Enova International I led a $200M portfolio consolidation and drove 200% increase in SDR productivity. I founded Promotable which grew to $40k/month revenue.';
          else if (/messy.*ambiguous|ambiguous.*thing|hardest part/.test(meta)) fillVal = 'At Enova I was handed a vague directive to wind down a $200M business unit with no playbook. I scoped the full initiative, identified every cross-functional dependency, built the project plan, and drove it to completion on time.';
          else if (/beyond your title|went beyond|no one asked/.test(meta)) fillVal = 'At App Academy I was hired as Business Operations Manager but ended up managing state regulatory relationships, running the financial audit conversion to GAAP, and building the CS team from scratch.';
          else if (/program.*end.to.end|execute.*program|program you.*own/.test(meta)) fillVal = 'At Enova I led a cross-functional program to close a $200M loan portfolio end-to-end: scoping with the COO, building the project plan, coordinating across legal, compliance, finance, product, and customer success.';
          else if (/measure success|metrics.*mattered|how did you measure/.test(meta)) fillVal = 'I track leading indicators alongside outcomes — milestone completion, stakeholder alignment, risk items resolved. Post-completion I measure cost reduction vs target, compliance audit pass rate, and team retention.';
          else if (/anything else|additional information|other.*information/.test(meta)) fillVal = 'Please see my attached resume for additional details.';
          else if (/notice period|earliest.*start|when.*available|start date/.test(meta)) fillVal = 'Immediately';
          else if (/previously.*employed|former.*employee/.test(meta)) fillVal = 'No';
          else if (/salary|compensation/.test(meta)) fillVal = '145000';

          if (fillVal && fillVal !== currentVal) {
            await input.scrollIntoViewIfNeeded();
            try {
              await input.focus(); await input.click({ clickCount: 3 });
              if (fillVal.length <= 80) {
                await page.keyboard.type(fillVal, { delay: 40 });
              } else {
                await input.fill(fillVal);
                await input.evaluate(el => {
                  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
                });
              }
              const confirmed = await input.evaluate(el => el.value).catch(() => '');
              if (!confirmed || confirmed.length < 3) { await input.fill(''); await input.type(fillVal.slice(0, 200), { delay: 20 }); }
            } catch(fe2) {
              await input.evaluate((el, val) => {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                if (setter) setter.call(el, val); else el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              }, fillVal).catch(() => {});
            }
            log('  ✓ Filled: ' + meta.slice(0, 40).trim());
          }
        } catch(fe) {}
      }
    } catch(e) { log('  ⚠ Field interceptor: ' + e.message.slice(0, 50)); }

    // Phone sweep
    try {
      const phoneSelectors = ['input[name="_systemfield_phone"]','input[id="_systemfield_phone"]','input[type="tel"]','input[placeholder*="phone" i]','input[aria-label*="phone" i]','input[autocomplete="tel"]'];
      let phoneFilled = false;
      for (const sel of phoneSelectors) {
        const pi = await page.$(sel).catch(() => null);
        if (!pi || !await pi.isVisible().catch(() => false)) continue;
        const existing = await pi.evaluate(el => el.value).catch(() => '');
        if (existing && existing.length > 5) { phoneFilled = true; break; }
        await pi.focus(); await pi.click({ clickCount: 3 });
        await page.keyboard.type(PROFILE.phone_formatted, { delay: 40 });
        const val = await pi.evaluate(el => el.value).catch(() => '');
        if (!val) { await pi.fill(PROFILE.phone_formatted); await pi.evaluate(e => { e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }); }
        log('  ✓ Phone sweep: ' + (await pi.evaluate(el => el.value).catch(() => '?')));
        phoneFilled = true; break;
      }
      if (!phoneFilled) log('  ⚠ Phone field not found by sweep');
    } catch(e) {}

    // Location
    try {
      const locInput = await page.$('input[placeholder*="Location" i], input[aria-label*="location" i], input[placeholder*="City" i]');
      if (locInput && await locInput.isVisible().catch(() => false)) {
        await locInput.click(); await locInput.type('San Mateo, CA', { delay: 50 }); await page.waitForTimeout(1000);
        const opt = await page.$('[role="option"]');
        if (opt) await opt.click(); else { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); }
      }
    } catch(e) {}

    // Consent checkboxes
    try {
      const checkboxes = await page.$$('input[type="checkbox"]');
      for (const cb of checkboxes) {
        if (await cb.isChecked().catch(() => true)) continue;
        const label = await cb.evaluate(el => { const l = document.querySelector(`label[for="${el.id}"]`); return (l?.innerText || el.closest('label')?.innerText || '').toLowerCase(); }).catch(() => '');
        if (/sms|text message|marketing|promotional/.test(label)) continue;
        if (/confidential|privacy policy|terms|acknowledge|agree|certify|consent/.test(label) || label === '') { await cb.evaluate(el => el.click()); }
      }
    } catch(e) {}

    // Resume upload with change event dispatch for React state
    if (resumePdfUrl) {
      const tmpPath = '/tmp/aaron_resume.pdf';
      await uploadResumePdf(page, resumePdfUrl, ['input[type="file"]']);
      // Fire change event after upload so React registers the file
      try {
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
          });
          log('  📎 File change event dispatched');
        }
      } catch(e) {}
    }

    const answers = job.generated_responses || {};
    for (const [question, answer] of Object.entries(answers)) await tryFillByLabel(page, question, String(answer));

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));

    const ashbyPromise = Promise.any([
      page.waitForResponse(res => res.url().includes('/api/non-auth/v1/postings/') && res.url().includes('/apply') && res.status() === 200, { timeout: 15000 }),
      page.waitForNavigation({ url: u => u.includes('/application/success'), waitUntil: 'domcontentloaded', timeout: 15000 }),
    ]).catch(() => null);

    const networkPromise = page.waitForResponse(resp => {
      const url = resp.url();
      return url.includes('ashbyhq.com') && (url.includes('/application') || url.includes('/apply') || url.includes('/submit')) && resp.request().method() === 'POST';
    }, { timeout: 15000 }).catch(() => null);

    // "How did you hear" combobox
    try {
      const allCombos = await page.$$('[role="combobox"]');
      for (const cb of allCombos) {
        if (!await cb.isVisible().catch(() => false)) continue;
        const pt = await cb.evaluate(el => { let p = el.parentElement; for (let i=0;i<5;i++){if(!p)break;if(p.innerText?.length>5)return p.innerText.toLowerCase();p=p.parentElement;}return ''; }).catch(() => '');
        if (/how did you hear|where did you hear|referral|source/.test(pt)) {
          await cb.click().catch(() => {}); await new Promise(r => setTimeout(r, 500));
          const opts = await page.$$('[role="option"]');
          for (const opt of opts) {
            const t = (await opt.innerText().catch(() => '')).toLowerCase();
            if (t.includes('linkedin') || t.includes('other') || t.includes('job board')) { await opt.click().catch(() => {}); break; }
          }
        }
      }
    } catch(e) {}

    const ashbyCaptcha = await page.$('#h-captcha, .h-captcha, iframe[src*="hcaptcha"]').catch(() => null);
    if (ashbyCaptcha) { log('  ⚠ CAPTCHA detected'); return { success: false, manual: true, message: 'CAPTCHA wall detected' }; }

    // Pre-submit: auto-select empty dropdowns
    try {
      const allSelects = await page.$$('select');
      for (const sel of allSelects) { const v = await sel.evaluate(el => el.value).catch(() => ''); if (!v) await sel.selectOption({ index: 1 }).catch(() => {}); }
    } catch(e) {}

    // Pre-submit: radio groups
    try {
      const radioGroups = await page.$$('[role="radiogroup"], [class*="radioGroup" i]');
      for (const group of radioGroups) {
        const checked = await group.$('[aria-checked="true"], input:checked');
        if (checked) continue;
        const gt = await group.evaluate(el => { let p=el.parentElement;for(let i=0;i<4;i++){if(!p)break;if(p.innerText?.length>10)return p.innerText.toLowerCase();p=p.parentElement;}return ''; }).catch(() => '');
        const pickNo = /sponsor|visa.*require/.test(gt);
        const target = pickNo ? 'no' : 'yes';
        const radios = await group.$$('[role="radio"], input[type="radio"], label');
        let picked = false;
        for (const r of radios) {
          const t = ((await r.innerText().catch(async () => await r.evaluate(el => el.value||'').catch(() => ''))) || '').toLowerCase().trim();
          if (t === target || t.startsWith(target)) { await r.click().catch(() => {}); picked = true; break; }
        }
        if (!picked && radios.length > 0) await radios[0].click().catch(() => {});
      }
    } catch(e) {}

    // Multi-step check
    try {
      const submitExists = await page.$('button:has-text("Submit Application"), button[type="submit"]');
      if (!submitExists) {
        const nextBtn = await page.$('button:has-text("Next"), button:has-text("Continue")');
        if (nextBtn && await nextBtn.isVisible().catch(() => false)) { log('  👉 Multi-step — clicking Next'); await nextBtn.click(); await page.waitForTimeout(1500); }
      }
    } catch(e) {}

    // Find submit button
    const ashbyBtnSelectors = ['button[type="submit"]','button:has-text("Submit Application")','button:has-text("Submit application")','button:has-text("Submit")','button:has-text("Apply Now")','button:has-text("Apply now")','button:has-text("Apply")'];
    let ashbyBtn = null;
    for (const sel of ashbyBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) { ashbyBtn = btn; log(`  🔘 Found: ${sel}`); break; }
    }

    if (!ashbyBtn) {
      const allBtns = await page.$$('button');
      const btnTexts = await Promise.all(allBtns.map(b => b.innerText().catch(() => '')));
      log(`  ⚠ No submit button. Buttons: ${btnTexts.filter(Boolean).join(' | ').slice(0, 100)}`);
    } else {
      await ashbyBtn.scrollIntoViewIfNeeded();
      await ashbyBtn.focus();
      await page.waitForTimeout(300);

      // Strategy 1: Tab+Enter
      log(`  🖱 Trying Tab+Enter...`);
      await ashbyBtn.evaluate(btn => btn.focus());
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);

      // Strategy 2: form.requestSubmit()
      if (page.url().includes('/application') && !page.url().includes('success')) {
        log(`  🔄 Trying form.requestSubmit()...`);
        const submitted = await page.evaluate(() => { const f=document.querySelector('form'); if(!f)return false; try{f.requestSubmit();return true;}catch(e){f.submit();return true;} }).catch(() => false);
        log(`  📋 requestSubmit: ${submitted}`);
        await page.waitForTimeout(800);
      }

      // Strategy 3: humanized click
      if (page.url().includes('/application') && !page.url().includes('success')) {
        log(`  🔄 Humanized click...`);
        const btnEl = await ashbyBtn.elementHandle();
        if (btnEl) await humanizedClick(page, btnEl);
        await page.waitForTimeout(500);
      }

      // Strategy 4: React pointer events
      if (page.url().includes('/application') && !page.url().includes('success')) {
        log(`  🔄 React pointer events...`);
        await ashbyBtn.evaluate(btn => {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isTrusted: true }));
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, isTrusted: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, isTrusted: true }));
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, isTrusted: true }));
        });
      }
    }

    const networkResp = await networkPromise;
    if (networkResp) {
      const status = networkResp.status();
      log(`  📡 Network: ${status} from ${networkResp.url().slice(0, 60)}`);
      if (status >= 400) return { success: false, message: `Ashby rejected: ${status}` };
    } else {
      log(`  📡 No POST detected`);
    }

    const ashbyResult = await ashbyPromise;
    const ashbyUrl = page.url();
    log(`  📍 ${ashbyUrl}`);

    if (ashbyResult || ashbyUrl.includes('/application/success') || ashbyUrl.includes('/thanks') || ashbyUrl.includes('/confirmation')) {
      return { success: true, message: 'Submitted via Ashby ✓' };
    }

    const successEl = await page.$('[class*="successPage" i], h1:has-text("Thank You"), h1:has-text("Application Submitted")').catch(() => null);
    if (successEl) return { success: true, message: 'Submitted via Ashby ✓ (success element)' };

    log(`  ⚠ Still on /application`);
    const ashbyErrorSelectors = ['div[class*="_error"]','[aria-invalid="true"]','span[class*="error"]','[class*="error"]','[class*="invalid"]'];
    let allErrors = [];
    for (const sel of ashbyErrorSelectors) {
      const els = await page.$$(sel);
      for (const el of els) { const t = (await el.textContent().catch(() => '')).trim(); if (t && t.length > 2 && !allErrors.includes(t)) allErrors.push(t); }
    }
    log(`  📋 Ashby errors: ${allErrors.length > 0 ? allErrors.slice(0,5).join(' | ') : '(none)'}`);

    await page.screenshot({ path: '/tmp/ashby-debug.png', fullPage: true }).catch(() => {});
    return { success: false, message: `Ashby: no confirmation at ${ashbyUrl}` };
  } catch (err) {
    return { success: false, message: `Ashby error: ${err.message}` };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function humanType(page, selector, value) {
  if (!value) return false;
  try {
    const el = await page.$(selector);
    if (!el) return false;
    await el.click(); await el.fill('');
    for (const char of value) { await page.keyboard.type(char); await page.waitForTimeout(Math.floor(Math.random() * 40 + 10)); }
    await page.waitForTimeout(Math.floor(Math.random() * 200 + 100));
    return true;
  } catch (e) { return false; }
}

async function clearAndType(page, selector, value) {
  if (!value) return false;
  try {
    const el = await page.$(selector);
    if (!el || !await el.isVisible().catch(() => false)) return false;
    await el.scrollIntoViewIfNeeded(); await el.click({ clickCount: 3 });
    await el.type(value, { delay: 50 + Math.floor(Math.random() * 50) });
    await el.evaluate(e => { e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); e.dispatchEvent(new Event('blur',{bubbles:true})); });
    return true;
  } catch (e) { return false; }
}

async function fillField(page, selectors, value) {
  if (!value) return false;
  for (const sel of selectors) {
    try { const el = await page.$(sel); if (el) { await el.fill(value); return true; } } catch (e) {}
  }
  return false;
}

async function handleRadioByText(page, questionRegex, answerRegex) {
  try {
    const fieldBlock = page.locator('div.field', { hasText: questionRegex });
    if (await fieldBlock.count() === 0) return false;
    const label = fieldBlock.locator('label', { hasText: answerRegex });
    if (await label.count() > 0) { await label.first().click(); return true; }
  } catch (e) {}
  return false;
}

async function handleDropdownByText(page, questionRegex, value) {
  try {
    const fieldBlock = page.locator('div.field', { hasText: questionRegex });
    if (await fieldBlock.count() === 0) return false;
    const select = fieldBlock.locator('select');
    if (await select.count() > 0) {
      await select.first().selectOption({ label: value }).catch(() => select.first().selectOption({ value: value.toLowerCase() }).catch(() => {}));
      return true;
    }
  } catch (e) {}
  return false;
}

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
            if (tag === 'textarea' || (tag === 'input' && !['radio','checkbox','file','hidden'].includes(type))) { await input.fill(value); return true; }
            if (tag === 'select') { await input.selectOption({ label: value }).catch(() => {}); return true; }
          }
        }
      }
    }
  } catch (e) {}
  return false;
}

async function uploadResumePdf(page, pdfUrl, selectors) {
  try {
    log(`  📥 Downloading resume...`);
    const tmpPath = require('path').resolve('/tmp', 'aaron_resume.pdf');
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      const dlController = new AbortController();
      const dlTimeout = setTimeout(() => dlController.abort(), 15000);
      try {
        const response = await fetch(pdfUrl, { signal: dlController.signal });
        clearTimeout(dlTimeout);
        if (!response.ok) { log(`  ⚠ Resume download failed: ${response.status}`); return false; }
        fs.writeFileSync(tmpPath, Buffer.from(await response.arrayBuffer()));
      } catch(dlErr) {
        clearTimeout(dlTimeout);
        log(`  ⚠ Download error: ${dlErr.message.slice(0,40)}`);
        if (!fs.existsSync(tmpPath)) return false;
      }
    } else { log(`  📎 Using cached resume`); }

    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) { log(`  ⚠ Resume missing`); return false; }
    log(`  💾 Resume ready: ${fs.statSync(tmpPath).size} bytes`);

    for (const sel of selectors) {
      const fileInput = await page.$(sel);
      if (fileInput) {
        await fileInput.setInputFiles(tmpPath);
        // Fire change event so React registers the file
        await fileInput.evaluate(el => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForTimeout(1500);
        log(`  ✅ Resume uploaded`);
        return true;
      }
    }
    log(`  ⚠ No file input found`);
    return false;
  } catch (e) { log(`  ⚠ Resume upload failed: ${e.message}`); return false; }
}

function saveLog() {
  fs.writeFileSync(`/tmp/submission-log-${Date.now()}.json`, JSON.stringify(runLog, null, 2));
  log(`\n📝 Run log saved`);
}

main().catch(err => {
  log(`💥 Fatal: ${err.message}`);
  runLog.error = err.message;
  saveLog();
  process.exit(1);
});

/**
 * Job Autopilot — Automated Application Submission
 */

const { chromium: vanillaChromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Stealth browser setup
let stealthChromium;
try {
  const { chromium: extraChromium } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  extraChromium.use(StealthPlugin());
  stealthChromium = extraChromium;
  console.log('[stealth] playwright-extra + stealth plugin loaded');
} catch(e) {
  try {
    const { chromium: reChromium } = require('rebrowser-playwright');
    stealthChromium = reChromium;
    console.log('[stealth] rebrowser-playwright loaded');
  } catch(e2) {
    stealthChromium = vanillaChromium;
    console.log('[stealth] using vanilla playwright');
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PROXY_URL = process.env.PROXY_URL || null;
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SUBMISSIONS = 10;
const MIN_SCORE = 75;
const DELAY_BETWEEN_MS = () => 12000 + Math.random() * 8000;

const RESUME_VARIANTS = { fintech: null, early_stage: null, default: null };

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

// Companies known to use hCaptcha on Lever — archive on detection
const LEVER_CAPTCHA_COMPANIES = ['cfgi','zoox','shieldai','moloco','anchorage','canary','anaplan','affirm'];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const runLog = { started_at: new Date().toISOString(), dry_run: DRY_RUN, results: [] };

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomFocus() { return FOCUS_ELEMENTS[Math.floor(Math.random() * FOCUS_ELEMENTS.length)]; }

// Humanized mouse click
async function humanizedClick(page, el) {
  try {
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
  const { count: rollbackCount } = await supabase
    .from('applications')
    .update({ status: 'queued', notes: 'Auto-recovered from stale processing state' })
    .eq('status', 'processing')
    .lt('started_at', staleWindow);
  if (rollbackCount > 0) log('♻ Recovered ' + rollbackCount + ' stale jobs');

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
  if (!jobs || jobs.length === 0) { log('✅ No jobs queued'); saveLog(); return; }
  log(`📋 Found ${jobs.length} jobs (min score: ${MIN_SCORE}%)`);

  const { data: resumeData } = await supabase
    .from('resumes').select('*').eq('is_active', true).limit(1).single();
  const resumeText = resumeData?.raw_text || '';
  RESUME_VARIANTS.default = resumeData?.pdf_url || null;
  log(`📄 Resume: ${resumeData?.filename || 'default'}`);

  const browser = await stealthChromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage', '--disable-infobars',
      '--window-size=1920,1080',
    ],
  });

  let submitted = 0, failed = 0, manual = 0, skipped = 0, duplicate = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const titleLower = (job.job_title || '').toLowerCase();
    const titleBlacklist = ['security operations','incident response',' soc ','v-bat','air vehicle',
      'drone operator','software engineer','backend engineer','frontend engineer','devops',
      'data scientist','machine learning engineer','legal counsel','attorney','accountant',
      'debt collection','collections specialist','field technician','hardware engineer',
      'network engineer','technical program manager'];
    if (titleBlacklist.some(t => titleLower.includes(t))) {
      try { await supabase.from('applications').update({ status: 'archived' }).eq('id', job.id); } catch(e) {}
      log(`  ⏭ Archived irrelevant: ${job.job_title}`);
      continue;
    }

    log(`\n[${i+1}/${jobs.length}] ${job.job_title} at ${job.company} (${job.ats_type})`);
    log(`  Score: ${job.match_score}% | Variant: ${job.resume_variant || 'default'}`);

    // Pre-flight
    try {
      const check = await fetch(job.url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if ([404, 410].includes(check.status)) {
        log(`  ⚰ Job gone (${check.status})`);
        await supabase.from('applications').update({ status: 'archived', notes: `HTTP ${check.status}` }).eq('id', job.id);
        skipped++; continue;
      }
      if ([301, 302].includes(check.status) && job.ats_type === 'lever') {
        const loc = check.headers.get('location') || '';
        if (!loc.includes(job.external_id)) {
          log(`  ⚰ Lever redirected away`);
          await supabase.from('applications').update({ status: 'archived', notes: 'Lever 302 redirect' }).eq('id', job.id);
          skipped++; continue;
        }
      }
    } catch (e) { log(`  ⚠ Pre-flight: ${e.message}`); }

    if (DRY_RUN) { log('  ⏭ DRY RUN'); runLog.results.push({ job_id: job.id, status: 'dry_run' }); skipped++; continue; }

    const { data: claimed } = await supabase
      .from('applications')
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', job.id).eq('status', 'queued').select();
    if (!claimed || claimed.length === 0) { log(`  ⏭ Already claimed`); skipped++; continue; }

    const resumePdfUrl = RESUME_VARIANTS[job.resume_variant || 'default'] || RESUME_VARIANTS.default;

    const context = await browser.newContext({
      bypassCSP: true,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2, hasTouch: false, locale: 'en-US',
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
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    });

    // Block images/media/fonts to save bandwidth
    await page.route('**/*', route => {
      const t = route.request().resourceType();
      if (['image','media','font'].includes(t)) route.abort();
      else route.continue();
    });

    page.on('console', msg => { if (msg.type() === 'error') log(`  🖥 ${msg.text()}`); });
    page.on('pageerror', err => log(`  🖥 JS error: ${err.message}`));

    try {
      let result;
      const focus = randomFocus();
      log(`  🎯 ${focus}`);

      if (job.ats_type === 'greenhouse') result = await submitGreenhouse(page, job, resumeText, resumePdfUrl, focus);
      else if (job.ats_type === 'lever') result = await submitLever(page, job, resumeText, resumePdfUrl, focus);
      else if (job.ats_type === 'ashby') result = await submitAshby(page, job, resumeText, resumePdfUrl, focus);

      if (result.duplicate) {
        await supabase.from('applications').update({ status: 'duplicate', notes: result.message }).eq('id', job.id);
        log(`  ♻ ${result.message}`); duplicate++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'duplicate' });
      } else if (result.manual) {
        // If CAPTCHA on Lever and company is known offender, archive instead of manual
        const companyLower = (job.company || '').toLowerCase();
        if (job.ats_type === 'lever' && LEVER_CAPTCHA_COMPANIES.some(c => companyLower.includes(c))) {
          await supabase.from('applications').update({ status: 'archived', notes: 'Lever hCaptcha — known blocker' }).eq('id', job.id);
          log(`  🗄 Archived Lever CAPTCHA company: ${job.company}`);
        } else {
          await supabase.from('applications').update({ status: 'manual', notes: result.message }).eq('id', job.id);
          log(`  📋 Manual: ${result.message}`);
        }
        manual++;
        runLog.results.push({ job_id: job.id, company: job.company, status: 'manual' });
      } else if (result.success) {
        await supabase.from('applications').update({ status: 'submitted', submission_time: Math.floor(Date.now()/1000), notes: result.message }).eq('id', job.id);
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
      await supabase.from('applications').update({ status: 'failed', notes: `Exception: ${err.message}` }).eq('id', job.id);
      failed++;
    } finally {
      await context.close();
    }

    if (i < jobs.length - 1) {
      const delay = Math.floor(DELAY_BETWEEN_MS());
      log(`  ⏳ Waiting ${Math.round(delay/1000)}s...`);
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
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) return null;
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
        if (res.data.messages?.length > 0) {
          for (const msg of res.data.messages) {
            const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
            const internalDate = parseInt(full.data.internalDate || '0', 10);
            if (internalDate < Date.now() - 600000) continue;
            const bodyData = full.data.payload?.body?.data || full.data.payload?.parts?.[0]?.body?.data || '';
            const fullText = (full.data.snippet || '') + ' ' + (bodyData ? Buffer.from(bodyData, 'base64').toString() : '');
            const codeMatch = fullText.match(/([a-zA-Z0-9]{8})/g);
            if (codeMatch) {
              const commonWords = ['security','passcode','confirm','complete','required','provided','yourself','application','submitted','greenhouse'];
              const code = codeMatch.find(c => !commonWords.includes(c.toLowerCase()));
              if (code) { log('  ✅ Security code: ' + code); return code; }
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
  if (c.includes('sponsor') || c.includes('visa') || c.includes('immigration') || c.includes('work permit') || c.includes('right to work support')) return 'No';
  if (c.includes('authorized') || c.includes('eligible to work') || c.includes('legally') || c.includes('right to work')) return 'Yes';
  if (c.includes('non-compete') || c.includes('non compete') || c.includes('non-solicit') || c.includes('former employer')) return 'No';
  if (c.includes('hybrid') || c.includes('in-office') || c.includes('in-person') || c.includes('relocat') || c.includes('willing to work') || c.includes('commit to being')) return 'Yes';
  if (c.includes('previously worked') || c.includes('worked for') || c.includes('formerly') || c.includes('ever worked') || c.includes('conflict of interest')) return 'No';
  if (c.includes('state of residence') || c.includes('current state') || c.includes('province')) return 'California';
  if (c.includes('metro') || c.includes('san francisco bay')) return 'San Francisco Bay';
  if (c.includes('veteran')) return 'I am not a protected veteran';
  if (c.includes('disability')) return 'No, I do not have a disability';
  if (c.includes('gender') || c.includes('race') || c.includes('ethnicity') || c.includes('ethnic') || c.includes('sexual orientation') || c.includes('lgbtq') || c.includes('transgender') || c.includes('pronoun')) return 'Decline';
  if (c.includes('school') || c.includes('university') || c.includes('college') || c.includes('institution')) return 'Georgetown University';
  if (c.includes('degree') || c.includes('level of education')) return "Master's";
  if (c.includes('discipline') || c.includes('field of study') || c.includes('major') || c.includes('area of study')) return 'European Studies';
  if (c.includes('graduation') || c.includes('grad year')) return '2015';
  if (c.includes('ai policy') || c.includes('use of ai') || c.includes('used ai')) return 'No';
  if (c.includes('m&a') || c.includes('merger') || c.includes('acquisition')) return 'No';
  if (c.includes('first-generation') || c.includes('first generation professional')) return 'Decline';
  if (c.includes('hear about') || c.includes('how did you') || c.includes('source') || c.includes('referred')) return 'LinkedIn';
  if (c.includes('sql') || c.includes('advanced knowledge')) return 'Yes';
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
    try { await page.waitForSelector('#application_form, #app, #first_name', { state: 'visible', timeout: 12000 }); await page.waitForTimeout(1500); }
    catch(e) { log('  ⚠ Form not found after 12s'); }

    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('greenhouse.io')) {
      const knownCustom = ['fivetran.com','airbnb.com','okta.com','lyft.com','pinterestcareers.com','samsara.com','databricks.com'];
      if (knownCustom.some(s => finalDomain.includes(s))) {
        try { await supabase.from('companies').update({ active: false, notes: 'custom career site' }).eq('ats_slug', job.ats_slug); } catch(e) {}
      }
      return { success: false, manual: true, message: `Custom site: ${finalDomain}` };
    }

    const debugHtml = await page.content();
    fs.writeFileSync(`/tmp/debug-greenhouse-${Date.now()}.html`, debugHtml.slice(0, 100000));

    if (!await page.$('form, #application-form, #main_fields')) return { success: false, message: `No form at ${page.url()}` };

    const ghCaptcha = await page.$('#g-recaptcha, .g-recaptcha, #h-captcha, .h-captcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').catch(() => null);
    if (ghCaptcha) { log('  ⚠ CAPTCHA detected'); return { success: false, manual: true, message: 'CAPTCHA wall detected' }; }

    await humanType(page, '#first_name', PROFILE.first_name);
    await humanType(page, '#last_name', PROFILE.last_name);
    await humanType(page, '#preferred_name', PROFILE.first_name);
    await humanType(page, '#email', PROFILE.email);
    await humanType(page, '#phone', PROFILE.phone_formatted);

    try {
      const locField = await page.$('#candidate-location, #job_application_location');
      if (locField) { await locField.click(); await locField.fill(''); await page.waitForTimeout(300); await locField.type(PROFILE.city, {delay:50}); await page.waitForTimeout(800); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
    } catch(e) {}

    try {
      const cf = await page.$('#country, input[id*="country" i]');
      if (cf) { await cf.click(); await cf.fill(''); await page.waitForTimeout(300); await cf.type('United States', {delay:50}); await page.waitForTimeout(1000); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); await page.waitForTimeout(500); }
      else { const cs = await page.$('select[id*="country" i]'); if (cs) await cs.selectOption({label:'United States'}).catch(() => cs.selectOption({value:'US'}).catch(() => {})); }
    } catch(e) {}

    for (const sel of ['input[name*="linkedin" i]','input[id*="linkedin" i]','input[placeholder*="linkedin" i]','[id="question_linkedin"]']) { if (await humanType(page, sel, PROFILE.linkedin)) break; }
    for (const sel of ['input[name*="website" i]','input[id*="website" i]']) { if (await humanType(page, sel, PROFILE.website)) break; }

    try {
      const cl = await page.$('input[type="file"][id="cover_letter"]');
      if (cl) { const p='/tmp/aaron_cover_letter.txt'; fs.writeFileSync(p,'Dear Hiring Manager,\n\nI am excited to apply for this role. With 10+ years in strategy and operations I bring a proven track record of driving operational excellence.\n\nBest regards,\nAaron Filous'); await cl.setInputFiles(p); }
    } catch(e) {}

    let resumeUploaded = false;
    if (resumePdfUrl) {
      resumeUploaded = await uploadResumePdf(page, resumePdfUrl, ['input[type="file"][id="resume"]','input[type="file"][id="resume_file"]','input[type="file"][name="job_application[resume]"]','input[type="file"][accept*="pdf"]','input[type="file"]']);
    }
    const resumeTextFilled = await fillField(page, ['#resume_text','textarea[name="job_application[resume_text]"]','textarea[id*="resume"]'], resumeText.slice(0,5000));
    if (resumeTextFilled) log(`  📝 Resume text filled`);

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));
    await handleRadioByText(page, /authorized.*work|work.*authorized|eligible.*work/i, /^Yes$/i);
    await handleRadioByText(page, /require.*sponsorship|visa sponsor|need.*sponsor/i, /^No$/i);

    try {
      const allFields = await page.$$('div.field, div[class*="field"]');
      for (const field of allFields) {
        const ft = (await field.textContent()||'').toLowerCase();
        if (/willing|authorized|legally|relocate|in.person|on.?site/i.test(ft)) {
          for (const lbl of await field.$$('label')) { const lt=(await lbl.textContent()||'').toLowerCase().trim(); if (lt==='yes'||lt==='i am'||lt==='willing'){await lbl.click();break;} }
        }
        if (/sponsorship|visa|sponsor/i.test(ft)) {
          for (const lbl of await field.$$('label')) { const lt=(await lbl.textContent()||'').toLowerCase().trim(); if (lt==='no'||lt==='i do not'){await lbl.click();break;} }
        }
      }
    } catch(e) {}

    await handleDropdownByText(page, /authorized.*work|work.*authorized/i, 'Yes');
    await handleDropdownByText(page, /require.*sponsorship|visa/i, 'No');
    try { const hs=await page.$('select[name*="referral" i],select[id*="heard" i]'); if(hs) await hs.selectOption({label:'LinkedIn'}).catch(()=>{}); } catch(e) {}

    try {
      for (const label of await page.$$('label')) {
        const rawLabel = (await label.textContent()||'');
        const forAttr = await label.getAttribute('for');
        if (!forAttr || !(forAttr.startsWith('question_') || /^\d/.test(forAttr))) continue;
        const el = await page.$(`[id="${forAttr}"]`);
        if (!el) continue;
        const tag = await el.evaluate(e=>e.tagName.toLowerCase());
        const inputType = await el.evaluate(e=>e.type||'');
        if (tag==='select') {
          const ans=getDropdownAnswer(rawLabel)||null;
          if (ans) await el.selectOption({label:ans}).catch(()=>el.selectOption({index:1}).catch(()=>{}));
          else await el.selectOption({index:1}).catch(()=>{});
        } else if (tag==='textarea'||(tag==='input'&&!['file','hidden','radio','checkbox'].includes(inputType))) {
          const dropAns=getDropdownAnswer(rawLabel);
          const isHidden=await page.evaluate(id=>{const e=document.getElementById(id);if(!e)return false;const s=window.getComputedStyle(e);if(s.opacity==='0'||s.visibility==='hidden')return true;const sibs=e.parentElement?[...e.parentElement.children]:[];return sibs.some(s=>s!==e&&(s.getAttribute('role')==='combobox'||(s.className&&typeof s.className==='string'&&(s.className.includes('css-')||s.className.includes('select')))));},forAttr).catch(()=>false);
          if (isHidden||(dropAns!==null&&inputType==='text')) {
            if (dropAns!==null) {
              try {
                const fc=await label.evaluateHandle(el=>{let p=el.parentElement;for(let i=0;i<6;i++){if(!p)break;const c=(p.className||'').toString();if(c.includes('field')||c.includes('Field')||p.tagName==='LI'||p.tagName==='SECTION')return p;p=p.parentElement;}return el.parentElement;});
                const trig=await fc.$('[class*="css-"][class*="control"],[role="combobox"],div[class*="Select"],div[class*="select__control"]').catch(()=>null);
                if (trig&&await trig.isVisible().catch(()=>false)) {
                  try { const hs2=await fc.$('select'); if(hs2){const opts=await hs2.$$eval('option',os=>os.map(o=>o.textContent.trim()));const m=opts.find(o=>o.toLowerCase().includes(dropAns.toLowerCase())||(dropAns==='No'&&o.toLowerCase()==='no')||(dropAns==='Yes'&&o.toLowerCase()==='yes')||(dropAns==='Decline'&&o.toLowerCase().includes('decline')));if(m){await hs2.selectOption({label:m});await hs2.evaluate(el=>el.dispatchEvent(new Event('change',{bubbles:true})));continue;}}} catch(e2){}
                  await trig.scrollIntoViewIfNeeded(); await trig.click({timeout:3000,force:true}); await page.waitForTimeout(600);
                  const opts=await page.$$('[role="option"],[class*="option"],ul[role="listbox"] li');
                  let picked=false;
                  for (const opt of opts) {
                    const ot=(await opt.innerText().catch(()=>'')).toLowerCase().trim();
                    if(ot.includes(dropAns.toLowerCase())||(dropAns==='Decline'&&(ot.includes('decline')||ot.includes('not wish')||ot.includes('prefer not')))||(dropAns==='No'&&(ot==='no'||ot.startsWith('no,')))||(dropAns==='Yes'&&(ot==='yes'||ot.startsWith('yes,')))||(dropAns==='California'&&ot.includes('california'))||(dropAns==='LinkedIn'&&ot.includes('linkedin'))||(dropAns==='I am not a protected veteran'&&ot.includes('not a protected'))||(dropAns==='No, I do not have a disability'&&ot.includes('do not have'))) {
                      await opt.click({timeout:1500}); picked=true; break;
                    }
                  }
                  if (!picked&&opts.length>0) for(const opt of opts){const ot=(await opt.innerText().catch(()=>'')).trim();if(ot&&!ot.toLowerCase().includes('select')&&!ot.toLowerCase().includes('choose')){await opt.click({timeout:1500});break;}}
                  await page.waitForTimeout(200);
                }
              } catch(e) {}
            }
          } else {
            let ans=null; const lt=rawLabel.toLowerCase();
            if(/linkedin/i.test(lt)) ans=PROFILE.linkedin;
            else if(/website|portfolio/i.test(lt)) ans=PROFILE.website;
            else if(/github/i.test(lt)) ans='https://github.com/afilous';
            else if(/preferred.*name|first name/i.test(lt)) ans=PROFILE.first_name;
            else if(/last name|surname/i.test(lt)) ans=PROFILE.last_name;
            else if(/full.*name|legal.*name/i.test(lt)) ans=PROFILE.full_name;
            else if(/pronouns/i.test(lt)) ans='He/Him';
            else if(/city/i.test(lt)) ans='San Mateo';
            else if(/zip|postal/i.test(lt)) ans='94401';
            else if(/address/i.test(lt)) ans='San Mateo, CA 94401';
            else if(/school|university|college/i.test(lt)) ans='Georgetown University';
            else if(/degree|level of education/i.test(lt)) ans="Master's";
            else if(/discipline|field of study|major/i.test(lt)) ans='European Studies';
            else if(/gpa/i.test(lt)) ans='3.7';
            else if(/graduation|grad.*year/i.test(lt)) ans='2015';
            else if(/company|employer/i.test(lt)) ans='Stealth Startup';
            else if(/title|position/i.test(lt)) ans='Strategy & Operations Lead';
            else if(/salary|compensation/i.test(lt)) ans='145000';
            else if(/years.*experience/i.test(lt)) ans='10';
            else if(/start.*date|available/i.test(lt)) ans='Immediately';
            else if(/why.*work|why.*join|what excites/i.test(lt)) ans='I am excited to apply my 10+ years of strategy and operations experience. At Enova International I led a $200M portfolio consolidation and drove 200% increase in SDR productivity.';
            else if(/experience|background|describe/i.test(lt)) ans='My background spans 10+ years in strategy and operations. At Enova I led a $200M portfolio consolidation and built SDR operations from the ground up.';
            else if(/sql/i.test(lt)) ans='Yes, I have advanced SQL skills including complex joins, window functions, and query optimization.';
            else if(/cover.*letter|additional.*info|anything.*else/i.test(lt)) ans='Please see my attached resume for additional details.';
            else if(/hear.*about|source|referred/i.test(lt)) ans='LinkedIn';
            else { const responses=job.generated_responses||{}; const cn=(job.company||'').toLowerCase(); for(const[q,a]of Object.entries(responses)){if(lt.includes(q.toLowerCase().slice(0,20))){const as=String(a).toLowerCase();const bad=['anthropic','faire','intercom','figma','affirm','gusto','chime','verkada','mixpanel','amplitude','wonderschool','loop','waymo','ramp'].some(c=>c!==cn&&as.includes(c));if(!bad){ans=String(a);break;}}} if(!ans) ans='Please see my attached resume for details.'; }
            await el.fill((ans||'').slice(0,500));
          }
        }
      }
    } catch(e) { log('  ⚠ Form handler: '+e.message); }

    // EEOC
    try {
      for(const lbl of await page.$$('label')){
        const lt=(await lbl.textContent().catch(()=>'')).toLowerCase().trim();
        if(!lt||!/gender|race|ethnic|disability|veteran|lgbtq|pronoun|transgender/.test(lt))continue;
        const fa=await lbl.getAttribute('for'); if(!fa)continue;
        const cont=await lbl.evaluateHandle(el=>{let p=el.parentElement;for(let i=0;i<5;i++){if(!p)break;if(p.children.length>1)return p;p=p.parentElement;}return el.parentElement;});
        const trig=await cont.$('[class*="css-"][class*="control"],[role="combobox"]').catch(()=>null);
        if(trig&&await trig.isVisible().catch(()=>false)){
          await trig.click({timeout:2000,force:true});await page.waitForTimeout(600);
          const opts=await page.$$('[role="option"]'); let picked=false;
          for(const opt of opts){const t=(await opt.innerText().catch(()=>'')).toLowerCase();if(t.includes('decline')||t.includes('not wish')||t.includes('prefer not')||t.includes('do not have')||t.includes('not a protected')){await opt.click({timeout:1500});picked=true;break;}}
          if(!picked&&opts.length>0)await opts[opts.length-1].click({timeout:1500}).catch(()=>{});
          await page.waitForTimeout(300);
        }
      }
    } catch(e){}
    for(const f of ['gender','hispanic_ethnicity','veteran_status','disability_status']){try{const el=await page.$(`[id="${f}"]`);if(!el)continue;const tag=await el.evaluate(e=>e.tagName.toLowerCase());if(tag==='select')await el.selectOption({index:1}).catch(()=>{});else{await el.click().catch(()=>{});await page.waitForTimeout(400);const opts=await page.$$('[role="option"],ul li,[class*="option"]');for(const opt of opts){const t=(await opt.innerText().catch(()=>'')).toLowerCase();if(t.includes('decline')||t.includes('not wish')||t.includes('not a protected')||t.includes('do not have')){await opt.click();break;}}}}catch(e){}}
    try{for(const lbl of await page.$$('label')){const t=(await lbl.innerText()||'').toLowerCase();if(t.includes('decline to self-identify')||t.includes('prefer not to say'))await lbl.click();}}catch(e){}

    const submitBtn = page.locator('#submit_app, input[type="submit"][value*="Submit" i], button[type="submit"]').first();
    if (await submitBtn.count()===0) return {success:false,message:'Submit button not found'};

    const successPromise = Promise.any([
      page.waitForRequest(req=>req.url().includes(`/v1/boards/${slug}/jobs/${jobId}/application`)&&req.method()==='POST',{timeout:15000}),
      page.waitForNavigation({url:u=>u.includes('confirmation'),waitUntil:'domcontentloaded',timeout:15000}),
    ]).catch(()=>null);

    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(Math.floor(Math.random()*1000+500));
    const submitEl = await submitBtn.elementHandle().catch(()=>null);
    if (submitEl) await humanizedClick(page, submitEl);
    else await submitBtn.click({delay:100}).catch(()=>{});
    log(`  🖱 Submitting...`);

    const result = await successPromise;
    const afterUrl = page.url();
    const pageText = await page.textContent('body').catch(()=>'');

    if (pageText.match(/already applied|already submitted|previously applied/i)) return {duplicate:true,message:'Already applied'};
    if (result) return {success:true,message:page.url().includes('confirmation')?'Submitted via Greenhouse ✓ (confirmed)':'Submitted via Greenhouse ✓ (POST intercepted)'};
    if (pageText.match(/thank you|application received|we received/i)) return {success:true,message:'Submitted via Greenhouse ✓ (DOM)'};
    if (afterUrl.includes('confirmation')) return {success:true,message:'Submitted via Greenhouse ✓ (URL)'};

    try {
      const si=page.locator('input[id*="verification"],input[id*="security"],input[name*="code"],input[placeholder*="code" i]');
      if(await si.count()>0&&await si.isVisible().catch(()=>false)){
        log('  🔒 Security code gate — polling Gmail...');
        const code=await pollForSecurityCode();
        if(code){await si.fill(code);await page.waitForTimeout(500);const rb=page.locator('button[type="submit"],input[type="submit"]').first();if(await rb.count()>0)await rb.click();await page.waitForTimeout(3000);}
      }
    } catch(e){}

    const ve=await page.evaluate(()=>[...document.querySelectorAll('.error,.field-error,[class*="error"],[class*="invalid"]')].map(e=>e.textContent?.trim()).filter(t=>t&&t.length>0).slice(0,10)).catch(()=>[]);
    if(ve.length>0){log(`  📋 Validation: ${ve.join(' | ')}`);return{success:false,message:`Validation: ${ve.slice(0,3).join(', ')}`};}

    await page.screenshot({path:'/tmp/greenhouse-debug.png',fullPage:true}).catch(()=>{});
    return {success:false,message:`No confirmation at ${afterUrl}`};
  } catch(err) { return {success:false,message:`Greenhouse error: ${err.message}`}; }
}

// ── Lever ─────────────────────────────────────────────────────────────────────
async function submitLever(page, job, resumeText, resumePdfUrl, focus) {
  try {
    const applyUrl = job.url.includes('/apply') ? job.url : `${job.url}/apply`;
    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl, {waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2000);

    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('lever.co')) return {success:false,manual:true,message:`Custom site: ${finalDomain}`};

    if (resumePdfUrl) {
      await uploadResumePdf(page, resumePdfUrl, ['input[type="file"][id="resume_file"]','input[type="file"]']);
      log(`  📎 Resume uploaded — waiting for parse...`);
      try {
        await Promise.race([
          page.waitForFunction(()=>{const n=document.querySelector('input[name="name"]');return n&&n.value&&n.value.length>1;},{timeout:12000}),
          new Promise(resolve=>setTimeout(()=>{log('  ⚠ Resume parse timeout');resolve();},12000)),
        ]);
      } catch(e) {}
    }

    const nameFilled = await clearAndType(page, 'input[name="name"]', PROFILE.full_name);
    const emailFilled = await clearAndType(page, 'input[name="email"]', PROFILE.email);
    const phoneFilled = await clearAndType(page, 'input[name="phone"]', PROFILE.phone_formatted);
    log(`  📝 name=${nameFilled} email=${emailFilled} phone=${phoneFilled}`);
    await clearAndType(page, 'input[name="urls[LinkedIn]"]', PROFILE.linkedin);
    await clearAndType(page, 'input[name="org"]', 'Stealth Startup').catch(()=>{});
    await clearAndType(page, 'input[name="location"]', 'San Mateo, CA').catch(()=>{});

    for (const block of await page.$$('.application-question,[data-qa="additional-cards"] .card,.cards-app-item')) {
      const bt=(await block.textContent().catch(()=>'')).toLowerCase();
      if(/sponsorship|visa sponsor|require.*sponsor/.test(bt)){const s=await block.$('select,[role="combobox"]');if(s)await s.selectOption({label:'No'}).catch(async()=>{await s.click().catch(()=>{});await new Promise(r=>setTimeout(r,400));const no=await page.$('[role="option"]:has-text("No")');if(no)await no.click().catch(()=>{});});const nr=await block.$('input[value="No"],label:has-text("No")');if(nr)await nr.click().catch(()=>{});}
      if(/how did you hear|hear about us/.test(bt)){const s=await block.$('select,[role="combobox"]');if(s)await s.selectOption({label:'LinkedIn'}).catch(async()=>{await s.click().catch(()=>{});await new Promise(r=>setTimeout(r,400));const o=await page.$('[role="option"]:has-text("LinkedIn")');if(o)await o.click().catch(()=>{});else{const oo=await page.$('[role="option"]:has-text("Other")');if(oo)await oo.click().catch(()=>{});}});}
      if(/authorized.*work|work.*authorized/.test(bt)){const y=await block.$('input[value="Yes"],label:has-text("Yes")');if(y)await y.click().catch(()=>{});}
      if(/pronoun/.test(bt)){const h=await block.$('label:has-text("He/him"),input[value*="he"]');if(h)await h.click().catch(()=>{});}
      if(/export.*control|citizen.*country/.test(bt)){const ti=await block.$('input[type="text"],textarea');if(ti){await ti.click().catch(()=>{});await ti.type('United States citizen',{delay:50+Math.floor(Math.random()*50)}).catch(()=>{});}}
      if(/preferred.*name|preferred first/.test(bt)){const ti=await block.$('input[type="text"]');if(ti&&await ti.isVisible().catch(()=>false)){const v=await ti.inputValue().catch(()=>'');if(!v)await ti.type(PROFILE.first_name,{delay:50}).catch(()=>{});}}
    }

    const answers=job.generated_responses||{};
    for(const[q,a]of Object.entries(answers))await tryFillByLabel(page,q,String(a));
    await page.waitForTimeout(Math.floor(Math.random()*800+400));

    const jobId=job.external_id; const slug=job.ats_slug;
    const leverPromise=Promise.any([
      page.waitForResponse(res=>res.url().includes(`/v1/postings/${slug}/${jobId}/apply`)&&res.status()===200,{timeout:15000}),
      page.waitForNavigation({url:u=>u.includes('/thanks'),waitUntil:'domcontentloaded',timeout:15000}),
    ]).catch(()=>null);

    const captcha=await page.$('#h-captcha,.h-captcha,iframe[src*="hcaptcha"],iframe[src*="recaptcha"]').catch(()=>null);
    if(captcha){log('  ⚠ CAPTCHA detected');return{success:false,manual:true,message:'CAPTCHA wall detected'};}

    let leverSubmitted=false;
    for(const sel of ['button[data-qa="btn-submit"]','.lever-button-black[type="submit"]','button[type="submit"]','input[type="submit"]','button:has-text("Submit Application")','button:has-text("Apply")',' button:has-text("Submit")',]){
      const btn=await page.$(sel);
      if(btn&&await btn.isVisible().catch(()=>false)){await btn.scrollIntoViewIfNeeded();await humanizedClick(page,btn);log(`  🖱 Lever submit: ${sel}`);leverSubmitted=true;break;}
    }
    if(!leverSubmitted)log('  ⚠ No Lever submit button');

    const leverResult=await leverPromise;
    const leverUrl=page.url();
    const leverText=await page.textContent('body').catch(()=>'');
    log(`  📍 ${leverUrl}`);

    if(leverResult||leverUrl.includes('/thanks'))return{success:true,message:'Submitted via Lever ✓'};
    if(leverText.match(/application submitted!|your application has been received|thank you for applying/i))return{success:true,message:'Submitted via Lever ✓ (DOM)'};
    await page.screenshot({path:'/tmp/lever-debug.png',fullPage:true}).catch(()=>{});
    return{success:false,message:`Lever: no confirmation at ${leverUrl}`};
  } catch(err){return{success:false,message:`Lever error: ${err.message}`};}
}

// ── Ashby ─────────────────────────────────────────────────────────────────────
async function submitAshby(page, job, resumeText, resumePdfUrl, focus) {
  try {
    const applyUrl=job.url.includes('/application')?job.url:`${job.url}/application`;
    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2000);

    const finalDomain=new URL(page.url()).hostname;
    if(!finalDomain.includes('ashbyhq.com'))return{success:false,manual:true,message:`Custom site: ${finalDomain}`};

    log('  📝 Filling Ashby form...');
    const ESSAY_ANSWER="I am most proud of building Promotable from scratch to $40k/month in revenue, selected as an education partner by 1871 Chicago's top tech incubator. I identified a gap in data skills training, built an automated omnichannel sales funnel, and converted a B2C audience to enterprise clients including McDonald's and City Colleges of Chicago.";

    try {
      const formInputs=await page.$$('input,textarea,[contenteditable="true"]');
      for(const input of formInputs){
        // Per-input timeout guard — prevents invisible element hangs
        await Promise.race([
          (async()=>{
            try {
              const isVisible=await input.isVisible().catch(()=>false);
              if(!isVisible)return;
              const inputType=await input.getAttribute('type').catch(()=>'');
              if(['file','hidden','submit','checkbox','radio'].includes(inputType))return;
              const inputId=await input.getAttribute('id').catch(()=>'')||'';
              const inputName=await input.getAttribute('name').catch(()=>'')||'';
              const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}/i;
              if(uuidPattern.test(inputId)||uuidPattern.test(inputName)){log('  ⚠ UUID honeypot: '+inputId.slice(0,20));return;}

              if(inputId==='_systemfield_phone'||inputName==='_systemfield_phone'){
                await input.focus();await input.click({clickCount:3});
                await page.keyboard.type(PROFILE.phone_formatted,{delay:40});
                const v=await input.evaluate(el=>el.value).catch(()=>'');
                if(!v){await input.fill(PROFILE.phone_formatted);await input.evaluate(e=>{e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});}
                log('  ✓ System phone: '+(await input.evaluate(el=>el.value).catch(()=>'?')));return;
              }
              if(inputId==='_systemfield_linkedin'||inputName==='_systemfield_linkedin'){
                await input.focus();await input.click({clickCount:3});
                await page.keyboard.type(PROFILE.linkedin,{delay:40});
                const v=await input.evaluate(el=>el.value).catch(()=>'');
                if(!v){await input.fill(PROFILE.linkedin);await input.evaluate(e=>{e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});}
                log('  ✓ System LinkedIn');return;
              }

              const isHoneypot=await input.evaluate(el=>{const r=el.getBoundingClientRect();if(r.width===0||r.height===0||r.width<5||r.height<5)return true;const s=window.getComputedStyle(el);return s.opacity==='0'||s.display==='none'||s.visibility==='hidden';}).catch(()=>false);
              if(isHoneypot)return;

              const meta=await input.evaluate(el=>{const parent=el.closest('[class*="field"],[class*="form"],label,li,div')||el.parentElement;const lbl=document.querySelector(`label[for="${el.id}"]`);return[el.getAttribute('placeholder')||'',el.getAttribute('aria-label')||'',el.getAttribute('name')||'',el.getAttribute('id')||'',lbl?.innerText||'',parent?.innerText?.slice(0,100)||''].join(' ').toLowerCase();}).catch(()=>'');

              const currentVal=await input.evaluate(el=>el.value||'').catch(()=>'');
              let fillVal=null;

              if(/\bfull.?name\b/.test(meta)||(/\bname\b/.test(meta)&&!meta.includes('company')&&!meta.includes('employer')&&!meta.includes('file')&&!meta.includes('school')&&!meta.includes('hear')&&meta.length<200)){fillVal=meta.includes('first')?PROFILE.first_name:meta.includes('last')?PROFILE.last_name:PROFILE.full_name;}
              else if(/\bemail\b/.test(meta)&&meta.length<200)fillVal=PROFILE.email;
              else if(/\bphone\b|\btel\b|phone number/.test(meta)&&meta.length<200)fillVal=PROFILE.phone_formatted;
              else if(/linkedin/.test(meta)){const li=PROFILE.linkedin;fillVal=li.startsWith('http')?li:'https://'+li;}
              else if(/\bwebsite\b|\bportfolio\b/.test(meta))fillVal=PROFILE.website;
              else if(/how did you hear|where did you hear|referral source/.test(meta))fillVal='LinkedIn';
              else if(/country.*reside|country.*currently|currently.*reside/.test(meta))fillVal='United States';
              else if(/country/.test(meta)&&meta.length<100)fillVal='United States';
              else if(/require.*sponsor|sponsor.*work|visa.*sponsor/.test(meta))fillVal='No';
              else if(/your pronouns|pronouns/.test(meta))fillVal='He/Him';
              else if(/legal.*first.*last|legal.*name|full.*legal/.test(meta))fillVal=PROFILE.full_name;
              else if(/preferred.*first|first.*preferred/.test(meta))fillVal=PROFILE.first_name;
              else if(/preferred.*last|last.*preferred/.test(meta))fillVal=PROFILE.last_name;
              else if(/current.*employer|most recent.*employer/.test(meta))fillVal='Stealth Startup';
              else if(/location/.test(meta)&&meta.length<80)fillVal='San Mateo, CA';
              else if(/current.*company|most recent.*company/.test(meta))fillVal='Stealth Startup';
              else if(/proud of|exceptional performance|something you/.test(meta))fillVal=ESSAY_ANSWER;
              else if(/what excites you|why.*want.*work|why do you want|why.*company|why.*role|why.*join|why.*interest|most excit|drawn to/.test(meta))fillVal='I am excited by the opportunity to apply my 10+ years of strategy and operations experience. At Enova International I led a $200M portfolio consolidation and drove 200% increase in SDR productivity. I founded Promotable which grew to $40k/month revenue.';
              else if(/messy.*ambiguous|hardest part/.test(meta))fillVal='At Enova I was handed a vague directive to wind down a $200M business unit with no playbook. I scoped the initiative, identified every cross-functional dependency, and drove it to completion on time.';
              else if(/beyond your title|went beyond|no one asked/.test(meta))fillVal='At App Academy I was hired as Business Operations Manager but ended up managing state regulatory relationships, running the financial audit conversion to GAAP, and building the CS team from scratch.';
              else if(/program.*end.to.end|execute.*program/.test(meta))fillVal='At Enova I led a cross-functional program to close a $200M loan portfolio end-to-end: scoping with the COO, coordinating across legal, compliance, finance, product, and customer success.';
              else if(/measure success|metrics.*mattered/.test(meta))fillVal='I track leading indicators alongside outcomes — milestone completion, stakeholder alignment, risk items resolved per sprint.';
              else if(/anything else|additional information/.test(meta))fillVal='Please see my attached resume for additional details.';
              else if(/notice period|earliest.*start|when.*available/.test(meta))fillVal='Immediately';
              else if(/previously.*employed|former.*employee/.test(meta))fillVal='No';
              else if(/salary|compensation/.test(meta))fillVal='145000';

              if(fillVal&&fillVal!==currentVal){
                await input.scrollIntoViewIfNeeded();
                try{
                  await input.focus();await input.click({clickCount:3});
                  if(fillVal.length<=80){await page.keyboard.type(fillVal,{delay:40});}
                  else{await input.fill(fillVal);await input.evaluate(el=>{el.dispatchEvent(new Event('input',{bubbles:true,cancelable:true}));el.dispatchEvent(new Event('change',{bubbles:true,cancelable:true}));el.dispatchEvent(new FocusEvent('blur',{bubbles:true}));});}
                  const confirmed=await input.evaluate(el=>el.value).catch(()=>'');
                  if(!confirmed||confirmed.length<3){await input.fill('');await input.type(fillVal.slice(0,200),{delay:20});}
                }catch(fe2){
                  await input.evaluate((el,val)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set||Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set;if(s)s.call(el,val);else el.value=val;el.dispatchEvent(new Event('input',{bubbles:true,cancelable:true}));el.dispatchEvent(new Event('change',{bubbles:true,cancelable:true}));},fillVal).catch(()=>{});
                }
                log('  ✓ Filled: '+meta.slice(0,40).trim());
              }
            } catch(fe){}
          })(),
          new Promise(resolve=>setTimeout(resolve, 5000)) // 5s per-input timeout guard
        ]);
      }
    } catch(e){log('  ⚠ Field interceptor: '+e.message.slice(0,50));}

    // Phone sweep
    try {
      let phoneFilled=false;
      for(const sel of ['input[name="_systemfield_phone"]','input[id="_systemfield_phone"]','input[type="tel"]','input[placeholder*="phone" i]','input[aria-label*="phone" i]','input[autocomplete="tel"]']){
        const pi=await page.$(sel).catch(()=>null);
        if(!pi||!await pi.isVisible().catch(()=>false))continue;
        const ex=await pi.evaluate(el=>el.value).catch(()=>'');
        if(ex&&ex.length>5){phoneFilled=true;break;}
        await pi.focus();await pi.click({clickCount:3});
        await page.keyboard.type(PROFILE.phone_formatted,{delay:40});
        const v=await pi.evaluate(el=>el.value).catch(()=>'');
        if(!v){await pi.fill(PROFILE.phone_formatted);await pi.evaluate(e=>{e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});}
        log('  ✓ Phone: '+(await pi.evaluate(el=>el.value).catch(()=>'?')));
        phoneFilled=true;break;
      }
      if(!phoneFilled)log('  ⚠ Phone not found');
    } catch(e){}

    // Location
    try {
      const li=await page.$('input[placeholder*="Location" i],input[aria-label*="location" i],input[placeholder*="City" i]');
      if(li&&await li.isVisible().catch(()=>false)){await li.click();await li.type('San Mateo, CA',{delay:50});await page.waitForTimeout(1000);const opt=await page.$('[role="option"]');if(opt)await opt.click();else{await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');}}
    } catch(e){}

    // Consent checkboxes
    try {
      for(const cb of await page.$$('input[type="checkbox"]')){
        if(await cb.isChecked().catch(()=>true))continue;
        const lbl=await cb.evaluate(el=>{const l=document.querySelector(`label[for="${el.id}"]`);return(l?.innerText||el.closest('label')?.innerText||'').toLowerCase();}).catch(()=>'');
        if(/sms|text message|marketing|promotional/.test(lbl))continue;
        if(/confidential|privacy policy|terms|acknowledge|agree|certify|consent/.test(lbl)||lbl==='')await cb.evaluate(el=>el.click());
      }
    } catch(e){}

    // Resume upload with React change event
    if(resumePdfUrl){
      await uploadResumePdf(page, resumePdfUrl, ['input[type="file"]']);
      try{const fi=await page.$('input[type="file"]');if(fi){await fi.evaluate(el=>{el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('input',{bubbles:true}));});log('  📎 File change event dispatched');}}catch(e){}
    }

    const answers=job.generated_responses||{};
    for(const[q,a]of Object.entries(answers))await tryFillByLabel(page,q,String(a));
    await page.waitForTimeout(Math.floor(Math.random()*800+400));

    const ashbyPromise=Promise.any([
      page.waitForResponse(res=>res.url().includes('/api/non-auth/v1/postings/')&&res.url().includes('/apply')&&res.status()===200,{timeout:15000}),
      page.waitForNavigation({url:u=>u.includes('/application/success'),waitUntil:'domcontentloaded',timeout:15000}),
    ]).catch(()=>null);

    const networkPromise=page.waitForResponse(resp=>{const u=resp.url();return u.includes('ashbyhq.com')&&(u.includes('/application')||u.includes('/apply')||u.includes('/submit'))&&resp.request().method()==='POST';},{timeout:15000}).catch(()=>null);

    // "How did you hear" combobox
    try{
      for(const cb of await page.$$('[role="combobox"]')){
        if(!await cb.isVisible().catch(()=>false))continue;
        const pt=await cb.evaluate(el=>{let p=el.parentElement;for(let i=0;i<5;i++){if(!p)break;if(p.innerText?.length>5)return p.innerText.toLowerCase();p=p.parentElement;}return '';}).catch(()=>'');
        if(/how did you hear|where did you hear|referral|source/.test(pt)){
          await cb.click().catch(()=>{});await new Promise(r=>setTimeout(r,500));
          const opts=await page.$$('[role="option"]');
          for(const opt of opts){const t=(await opt.innerText().catch(()=>'')).toLowerCase();if(t.includes('linkedin')||t.includes('other')||t.includes('job board')){await opt.click().catch(()=>{});break;}}
        }
      }
    }catch(e){}

    const ashbyCaptcha=await page.$('#h-captcha,.h-captcha,iframe[src*="hcaptcha"]').catch(()=>null);
    if(ashbyCaptcha){log('  ⚠ CAPTCHA detected');return{success:false,manual:true,message:'CAPTCHA wall detected'};}

    // Pre-submit sweeps
    try{const sels=await page.$$('select');for(const s of sels){const v=await s.evaluate(el=>el.value).catch(()=>'');if(!v)await s.selectOption({index:1}).catch(()=>{});}}catch(e){}
    try{
      for(const group of await page.$$('[role="radiogroup"],[class*="radioGroup" i]')){
        const checked=await group.$('[aria-checked="true"],input:checked');if(checked)continue;
        const gt=await group.evaluate(el=>{let p=el.parentElement;for(let i=0;i<4;i++){if(!p)break;if(p.innerText?.length>10)return p.innerText.toLowerCase();p=p.parentElement;}return '';}).catch(()=>'');
        const target=/sponsor|visa.*require/.test(gt)?'no':'yes';
        const radios=await group.$$('[role="radio"],input[type="radio"],label');
        let picked=false;
        for(const r of radios){const t=((await r.innerText().catch(async()=>await r.evaluate(el=>el.value||'').catch(()=>''))))||'';if(t.toLowerCase().trim()===target||t.toLowerCase().startsWith(target)){await r.click().catch(()=>{});picked=true;break;}}
        if(!picked&&radios.length>0)await radios[0].click().catch(()=>{});
      }
    }catch(e){}

    // Multi-step check
    try{const se=await page.$('button:has-text("Submit Application"),button[type="submit"]');if(!se){const nb=await page.$('button:has-text("Next"),button:has-text("Continue")');if(nb&&await nb.isVisible().catch(()=>false)){log('  👉 Multi-step — Next');await nb.click();await page.waitForTimeout(1500);}}}catch(e){}

    // ── Find submit button and grab element handle ONCE upfront ──────────────
    const ashbyBtnSelectors=['button[type="submit"]','button:has-text("Submit Application")','button:has-text("Submit application")','button:has-text("Submit")','button:has-text("Apply Now")','button:has-text("Apply now")','button:has-text("Apply")'];
    let ashbyBtnEl = null;
    for(const sel of ashbyBtnSelectors){
      const btn=page.locator(sel).first();
      if(await btn.count()>0&&await btn.isVisible().catch(()=>false)){
        ashbyBtnEl = await btn.elementHandle().catch(()=>null);
        if(ashbyBtnEl){ log(`  🔘 Found: ${sel}`); break; }
      }
    }

    if(!ashbyBtnEl){
      const allBtns=await page.$$('button');
      const btnTexts=await Promise.all(allBtns.map(b=>b.innerText().catch(()=>'')));
      log(`  ⚠ No submit button. Buttons: ${btnTexts.filter(Boolean).join(' | ').slice(0,100)}`);
    } else {
      await ashbyBtnEl.scrollIntoViewIfNeeded();
      await ashbyBtnEl.focus().catch(()=>{});
      await page.waitForTimeout(300);

      // Strategy 1: Tab+Enter
      log(`  🖱 Tab+Enter...`);
      await ashbyBtnEl.focus().catch(()=>{});
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);

      // Strategy 2: form.requestSubmit()
      if(page.url().includes('/application')&&!page.url().includes('success')){
        log(`  🔄 form.requestSubmit()...`);
        const ok=await page.evaluate(()=>{const f=document.querySelector('form');if(!f)return false;try{f.requestSubmit();return true;}catch(e){f.submit();return true;}}).catch(()=>false);
        log(`  📋 requestSubmit: ${ok}`);
        await page.waitForTimeout(800);
      }

      // Strategy 3: humanized click (using already-grabbed element handle)
      if(page.url().includes('/application')&&!page.url().includes('success')){
        log(`  🔄 Humanized click...`);
        await humanizedClick(page, ashbyBtnEl);
        await page.waitForTimeout(500);
      }

      // Strategy 4: React pointer events
      if(page.url().includes('/application')&&!page.url().includes('success')){
        log(`  🔄 React pointer events...`);
        await ashbyBtnEl.evaluate(btn=>{
          btn.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,isTrusted:true}));
          btn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,isTrusted:true}));
          btn.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,isTrusted:true}));
          btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,isTrusted:true}));
        }).catch(()=>{});
      }
    }

    const networkResp=await networkPromise;
    if(networkResp){log(`  📡 Network: ${networkResp.status()} from ${networkResp.url().slice(0,60)}`);if(networkResp.status()>=400)return{success:false,message:`Ashby rejected: ${networkResp.status()}`};}
    else log(`  📡 No POST detected`);

    const ashbyResult=await ashbyPromise;
    const ashbyUrl=page.url();
    log(`  📍 ${ashbyUrl}`);

    if(ashbyResult||ashbyUrl.includes('/application/success')||ashbyUrl.includes('/thanks')||ashbyUrl.includes('/confirmation'))return{success:true,message:'Submitted via Ashby ✓'};
    const se2=await page.$('[class*="successPage" i],h1:has-text("Thank You"),h1:has-text("Application Submitted")').catch(()=>null);
    if(se2)return{success:true,message:'Submitted via Ashby ✓ (success element)'};

    log(`  ⚠ Still on /application`);
    const errs=[];
    for(const sel of ['div[class*="_error"]','[aria-invalid="true"]','span[class*="error"]','[class*="error"]','[class*="invalid"]']){
      const els=await page.$$(sel);
      for(const el of els){const t=(await el.textContent().catch(()=>'')).trim();if(t&&t.length>2&&!errs.includes(t))errs.push(t);}
    }
    log(`  📋 Ashby errors: ${errs.length>0?errs.slice(0,5).join(' | '):'(none)'}`);
    await page.screenshot({path:'/tmp/ashby-debug.png',fullPage:true}).catch(()=>{});
    return{success:false,message:`Ashby: no confirmation at ${ashbyUrl}`};
  } catch(err){return{success:false,message:`Ashby error: ${err.message}`};}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function humanType(page, selector, value) {
  if(!value)return false;
  try{const el=await page.$(selector);if(!el)return false;await el.click();await el.fill('');for(const c of value){await page.keyboard.type(c);await page.waitForTimeout(Math.floor(Math.random()*40+10));}await page.waitForTimeout(Math.floor(Math.random()*200+100));return true;}catch(e){return false;}
}

async function clearAndType(page, selector, value) {
  if(!value)return false;
  try{const el=await page.$(selector);if(!el||!await el.isVisible().catch(()=>false))return false;await el.scrollIntoViewIfNeeded();await el.click({clickCount:3});await el.type(value,{delay:50+Math.floor(Math.random()*50)});await el.evaluate(e=>{e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}));});return true;}catch(e){return false;}
}

async function fillField(page, selectors, value) {
  if(!value)return false;
  for(const sel of selectors){try{const el=await page.$(sel);if(el){await el.fill(value);return true;}}catch(e){}}
  return false;
}

async function handleRadioByText(page, questionRegex, answerRegex) {
  try{const fb=page.locator('div.field',{hasText:questionRegex});if(await fb.count()===0)return false;const lbl=fb.locator('label',{hasText:answerRegex});if(await lbl.count()>0){await lbl.first().click();return true;}}catch(e){}return false;
}

async function handleDropdownByText(page, questionRegex, value) {
  try{const fb=page.locator('div.field',{hasText:questionRegex});if(await fb.count()===0)return false;const sel=fb.locator('select');if(await sel.count()>0){await sel.first().selectOption({label:value}).catch(()=>sel.first().selectOption({value:value.toLowerCase()}).catch(()=>{}));return true;}}catch(e){}return false;
}

async function tryFillByLabel(page, labelText, value) {
  if(!value||!labelText)return false;
  try{for(const lbl of await page.$$('label')){const t=await lbl.textContent();if(t&&t.toLowerCase().includes(labelText.toLowerCase().slice(0,25))){const fa=await lbl.getAttribute('for');if(fa){const inp=await page.$(`[id="${fa}"]`);if(inp){const tag=await inp.evaluate(el=>el.tagName.toLowerCase());const type=await inp.evaluate(el=>el.type||'');if(tag==='textarea'||(tag==='input'&&!['radio','checkbox','file','hidden'].includes(type))){await inp.fill(value);return true;}if(tag==='select'){await inp.selectOption({label:value}).catch(()=>{});return true;}}}}}}catch(e){}return false;
}

async function uploadResumePdf(page, pdfUrl, selectors) {
  try {
    log(`  📥 Downloading resume...`);
    const tmpPath=require('path').resolve('/tmp','aaron_resume.pdf');
    if(!fs.existsSync(tmpPath)||fs.statSync(tmpPath).size===0){
      const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),15000);
      try{const r=await fetch(pdfUrl,{signal:ctrl.signal});clearTimeout(t);if(!r.ok){log(`  ⚠ Download failed: ${r.status}`);return false;}fs.writeFileSync(tmpPath,Buffer.from(await r.arrayBuffer()));}
      catch(e){clearTimeout(t);log(`  ⚠ Download error: ${e.message.slice(0,40)}`);if(!fs.existsSync(tmpPath))return false;}
    } else log(`  📎 Using cached resume`);
    if(!fs.existsSync(tmpPath)||fs.statSync(tmpPath).size===0){log(`  ⚠ Resume missing`);return false;}
    log(`  💾 Resume ready: ${fs.statSync(tmpPath).size} bytes`);
    for(const sel of selectors){const fi=await page.$(sel);if(fi){await fi.setInputFiles(tmpPath);await fi.evaluate(el=>{el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('input',{bubbles:true}));});await page.waitForTimeout(1500);log(`  ✅ Resume uploaded`);return true;}}
    log(`  ⚠ No file input found`);return false;
  } catch(e){log(`  ⚠ Resume upload failed: ${e.message}`);return false;}
}

function saveLog() {
  fs.writeFileSync(`/tmp/submission-log-${Date.now()}.json`,JSON.stringify(runLog,null,2));
  log(`\n📝 Run log saved`);
}

main().catch(err=>{log(`💥 Fatal: ${err.message}`);runLog.error=err.message;saveLog();process.exit(1);});

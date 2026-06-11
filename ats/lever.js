/**
 * ats/lever.js — Lever application handler
 */

const { PROFILE } = require('../lib/profile');
const { clearAndType, humanizedClick, tryFillByLabel } = require('../lib/helpers');
const { uploadResume } = require('../lib/resume');
const { handleCaptcha } = require('../lib/captcha');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function submitLever(page, job, resumeText, resumePdfUrl) {
  try {
    const applyUrl = job.url.includes('/apply') ? job.url : `${job.url}/apply`;
    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('lever.co')) return { success: false, manual: true, message: `Custom site: ${finalDomain}` };

    // Resume upload first — Lever auto-parses
    if (resumePdfUrl) {
      await uploadResume(page, ['input[type="file"][id="resume_file"]','input[type="file"]']);
      log(`  📎 Resume uploaded — waiting for parse...`);
      try {
        await Promise.race([
          page.waitForFunction(() => { const n = document.querySelector('input[name="name"]'); return n && n.value && n.value.length > 1; }, { timeout: 12000 }),
          new Promise(resolve => setTimeout(() => { log('  ⚠ Resume parse timeout'); resolve(); }, 12000)),
        ]);
      } catch(e) {}
    }

    // Fill core fields
    const nameFilled = await clearAndType(page, 'input[name="name"]', PROFILE.full_name);
    const emailFilled = await clearAndType(page, 'input[name="email"]', PROFILE.email);
    const phoneFilled = await clearAndType(page, 'input[name="phone"]', PROFILE.phone_formatted);
    log(`  📝 name=${nameFilled} email=${emailFilled} phone=${phoneFilled}`);

    await clearAndType(page, 'input[name="urls[LinkedIn]"]', PROFILE.linkedin);
    await clearAndType(page, 'input[name="org"]', 'Stealth Startup').catch(() => {});
    await clearAndType(page, 'input[name="location"]', 'San Mateo, CA').catch(() => {});

    // Custom question blocks
    for (const block of await page.$$('.application-question,[data-qa="additional-cards"] .card,.cards-app-item')) {
      const bt = (await block.textContent().catch(() => '')).toLowerCase();
      if (/sponsorship|visa sponsor|require.*sponsor/.test(bt)) {
        const s = await block.$('select,[role="combobox"]');
        if (s) await s.selectOption({ label: 'No' }).catch(async () => { await s.click().catch(() => {}); await new Promise(r => setTimeout(r, 400)); const no = await page.$('[role="option"]:has-text("No")'); if (no) await no.click().catch(() => {}); });
        const nr = await block.$('input[value="No"],label:has-text("No")'); if (nr) await nr.click().catch(() => {});
      }
      if (/how did you hear|hear about us/.test(bt)) {
        const s = await block.$('select,[role="combobox"]');
        if (s) await s.selectOption({ label: 'LinkedIn' }).catch(async () => { await s.click().catch(() => {}); await new Promise(r => setTimeout(r, 400)); const o = await page.$('[role="option"]:has-text("LinkedIn")'); if (o) await o.click().catch(() => {}); else { const oo = await page.$('[role="option"]:has-text("Other")'); if (oo) await oo.click().catch(() => {}); } });
      }
      if (/authorized.*work|work.*authorized/.test(bt)) { const y = await block.$('input[value="Yes"],label:has-text("Yes")'); if (y) await y.click().catch(() => {}); }
      if (/pronoun/.test(bt)) { const h = await block.$('label:has-text("He/him"),input[value*="he"]'); if (h) await h.click().catch(() => {}); }
      if (/export.*control|citizen.*country/.test(bt)) { const ti = await block.$('input[type="text"],textarea'); if (ti) { await ti.click().catch(() => {}); await ti.type('United States citizen', { delay: 50 + Math.floor(Math.random() * 50) }).catch(() => {}); } }
      if (/preferred.*name|preferred first/.test(bt)) { const ti = await block.$('input[type="text"]'); if (ti && await ti.isVisible().catch(() => false)) { const v = await ti.inputValue().catch(() => ''); if (!v) await ti.type(PROFILE.first_name, { delay: 50 }).catch(() => {}); } }
    }

    const answers = job.generated_responses || {};
    for (const [q, a] of Object.entries(answers)) await tryFillByLabel(page, q, String(a));

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));

    // Check for CAPTCHA — try to solve
    const captchaEl = await page.$('#h-captcha,.h-captcha,iframe[src*="hcaptcha"],iframe[src*="recaptcha"]').catch(() => null);
    if (captchaEl) {
      log('  🧩 CAPTCHA detected — attempting solve...');
      const solved = await handleCaptcha(page);
      if (!solved) { log('  ⚠ CAPTCHA unsolvable'); return { success: false, manual: true, message: 'CAPTCHA wall detected' }; }
      await page.waitForTimeout(2000);
    }

    const jobId = job.external_id;
    const slug = job.ats_slug;
    const leverPromise = Promise.any([
      page.waitForResponse(res => res.url().includes(`/v1/postings/${slug}/${jobId}/apply`) && res.status() === 200, { timeout: 15000 }),
      page.waitForNavigation({ url: u => u.includes('/thanks'), waitUntil: 'domcontentloaded', timeout: 15000 }),
    ]).catch(() => null);

    let leverSubmitted = false;
    for (const sel of ['button[data-qa="btn-submit"]','.lever-button-black[type="submit"]','button[type="submit"]','input[type="submit"]','button:has-text("Submit Application")','button:has-text("Apply")','button:has-text("Submit")']) {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded();
        await humanizedClick(page, btn);
        log(`  🖱 Lever submit: ${sel}`); leverSubmitted = true; break;
      }
    }
    if (!leverSubmitted) log('  ⚠ No Lever submit button');

    const leverResult = await leverPromise;
    const leverUrl = page.url();
    const leverText = await page.textContent('body').catch(() => '');
    log(`  📍 ${leverUrl}`);

    if (leverResult || leverUrl.includes('/thanks')) return { success: true, message: 'Submitted via Lever ✓' };
    if (leverText.match(/application submitted!|your application has been received|thank you for applying/i)) return { success: true, message: 'Submitted via Lever ✓ (DOM)' };

    await page.screenshot({ path: '/tmp/lever-debug.png', fullPage: true }).catch(() => {});
    return { success: false, message: `Lever: no confirmation at ${leverUrl}` };
  } catch(err) { return { success: false, message: `Lever error: ${err.message}` }; }
}

module.exports = { submitLever };

/**
 * ats/greenhouse.js — Greenhouse application handler
 */

const fs = require('fs');
const { PROFILE, getDropdownAnswer, getTextAnswer } = require('../lib/profile');
const { humanType, humanizedClick, handleRadioByText, handleDropdownByText, fillField, fillReactField } = require('../lib/helpers');
const { uploadResume } = require('../lib/resume');
const { handleCaptcha } = require('../lib/captcha');
const { pollForSecurityCode } = require('../lib/gmail');
const { supabase } = require('../lib/supabase');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function submitGreenhouse(page, job, resumeText, resumePdfUrl) {
  try {
    const jobId = job.external_id;
    const slug = job.ats_slug;
    const applyUrl = `https://boards.greenhouse.io/${slug}/jobs/${jobId}?gh_jid=${jobId}#app`;
    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'load', timeout: 30000 });
    try {
      await page.waitForSelector('#application_form, #app, #first_name', { state: 'visible', timeout: 12000 });
      await page.waitForTimeout(1500);
    } catch(e) { log('  ⚠ Form not found after 12s'); }

    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('greenhouse.io')) {
      const knownCustom = ['fivetran.com','airbnb.com','okta.com','lyft.com','pinterestcareers.com','samsara.com','databricks.com'];
      if (knownCustom.some(s => finalDomain.includes(s))) {
        try { await supabase.from('companies').update({ active: false, notes: 'custom career site' }).eq('ats_slug', job.ats_slug); } catch(e) {}
      }
      return { success: false, manual: true, message: `Custom site: ${finalDomain}` };
    }

    // Save debug HTML
    const debugHtml = await page.content();
    fs.writeFileSync(`/tmp/debug-greenhouse-${Date.now()}.html`, debugHtml.slice(0, 100000));

    if (!await page.$('form, #application-form, #main_fields')) {
      return { success: false, message: `No form at ${page.url()}` };
    }

    // Check for CAPTCHA — try to solve it
    const captchaEl = await page.$('#g-recaptcha, .g-recaptcha, #h-captcha, .h-captcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').catch(() => null);
    if (captchaEl) {
      log('  🧩 CAPTCHA detected — attempting solve...');
      const solved = await handleCaptcha(page);
      if (!solved) {
        log('  ⚠ CAPTCHA unsolvable — marking manual');
        return { success: false, manual: true, message: 'CAPTCHA wall detected' };
      }
      await page.waitForTimeout(2000);
    }

    // Fill standard fields
    await humanType(page, '#first_name', PROFILE.first_name);
    await humanType(page, '#last_name', PROFILE.last_name);
    await humanType(page, '#preferred_name', PROFILE.first_name);
    await humanType(page, '#email', PROFILE.email);
    await humanType(page, '#phone', PROFILE.phone_formatted);

    // Location
    try {
      const locField = await page.$('#candidate-location, #job_application_location');
      if (locField) {
        await locField.click(); await locField.fill(''); await page.waitForTimeout(300);
        await locField.type(PROFILE.city, { delay: 50 }); await page.waitForTimeout(800);
        await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
      }
    } catch(e) {}

    // Country
    try {
      const cf = await page.$('#country, input[id*="country" i]');
      if (cf) {
        await cf.click(); await cf.fill(''); await page.waitForTimeout(300);
        await cf.type('United States', { delay: 50 }); await page.waitForTimeout(1000);
        await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300);
        await page.keyboard.press('Enter'); await page.waitForTimeout(500);
      } else {
        const cs = await page.$('select[id*="country" i]');
        if (cs) await cs.selectOption({ label: 'United States' }).catch(() => cs.selectOption({ value: 'US' }).catch(() => {}));
      }
    } catch(e) {}

    // LinkedIn + website
    for (const sel of ['input[name*="linkedin" i]','input[id*="linkedin" i]','input[placeholder*="linkedin" i]','[id="question_linkedin"]']) {
      if (await humanType(page, sel, PROFILE.linkedin)) break;
    }
    for (const sel of ['input[name*="website" i]','input[id*="website" i]']) {
      if (await humanType(page, sel, PROFILE.website)) break;
    }

    // Cover letter
    try {
      const cl = await page.$('input[type="file"][id="cover_letter"]');
      if (cl) {
        const p = '/tmp/aaron_cover_letter.txt';
        fs.writeFileSync(p, `Dear Hiring Manager,\n\nI am excited to apply for this role. With 10+ years in strategy and operations I bring a proven track record of driving operational excellence.\n\nBest regards,\nAaron Filous`);
        await cl.setInputFiles(p);
      }
    } catch(e) {}

    // Resume
    if (resumePdfUrl) {
      await uploadResume(page, ['input[type="file"][id="resume"]','input[type="file"][id="resume_file"]','input[type="file"][name="job_application[resume]"]','input[type="file"][accept*="pdf"]','input[type="file"]']);
    }
    await fillField(page, ['#resume_text','textarea[name="job_application[resume_text]"]'], resumeText.slice(0, 5000));

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));

    // Radio buttons
    await handleRadioByText(page, /authorized.*work|work.*authorized|eligible.*work/i, /^Yes$/i);
    await handleRadioByText(page, /require.*sponsorship|visa sponsor|need.*sponsor/i, /^No$/i);

    // Radio sweep
    try {
      for (const field of await page.$$('div.field, div[class*="field"]')) {
        const ft = (await field.textContent() || '').toLowerCase();
        if (/willing|authorized|legally|relocate|in.person|on.?site/i.test(ft)) {
          for (const lbl of await field.$$('label')) {
            const lt = (await lbl.textContent() || '').toLowerCase().trim();
            if (lt === 'yes' || lt === 'i am' || lt === 'willing') { await lbl.click(); break; }
          }
        }
        if (/sponsorship|visa|sponsor/i.test(ft)) {
          for (const lbl of await field.$$('label')) {
            const lt = (await lbl.textContent() || '').toLowerCase().trim();
            if (lt === 'no' || lt === 'i do not') { await lbl.click(); break; }
          }
        }
      }
    } catch(e) {}

    await handleDropdownByText(page, /authorized.*work|work.*authorized/i, 'Yes');
    await handleDropdownByText(page, /require.*sponsorship|visa/i, 'No');

    try {
      const hs = await page.$('select[name*="referral" i],select[id*="heard" i]');
      if (hs) await hs.selectOption({ label: 'LinkedIn' }).catch(() => {});
    } catch(e) {}

    // Question fields
    try {
      for (const label of await page.$$('label')) {
        const rawLabel = (await label.textContent() || '');
        const forAttr = await label.getAttribute('for');
        if (!forAttr || !(forAttr.startsWith('question_') || /^\d/.test(forAttr))) continue;
        const el = await page.$(`[id="${forAttr}"]`);
        if (!el) continue;
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        const inputType = await el.evaluate(e => e.type || '');

        if (tag === 'select') {
          const ans = getDropdownAnswer(rawLabel) || null;
          if (ans) await el.selectOption({ label: ans }).catch(() => el.selectOption({ index: 1 }).catch(() => {}));
          else await el.selectOption({ index: 1 }).catch(() => {});
        } else if (tag === 'textarea' || (tag === 'input' && !['file','hidden','radio','checkbox'].includes(inputType))) {
          const dropAns = getDropdownAnswer(rawLabel);
          const isHidden = await page.evaluate(id => {
            const e = document.getElementById(id); if (!e) return false;
            const s = window.getComputedStyle(e);
            if (s.opacity === '0' || s.visibility === 'hidden') return true;
            const sibs = e.parentElement ? [...e.parentElement.children] : [];
            return sibs.some(s => s !== e && (s.getAttribute('role') === 'combobox' || (s.className && typeof s.className === 'string' && (s.className.includes('css-') || s.className.includes('select')))));
          }, forAttr).catch(() => false);

          if (isHidden || (dropAns !== null && inputType === 'text')) {
            if (dropAns !== null) {
              try {
                const fc = await label.evaluateHandle(el => { let p = el.parentElement; for (let i=0;i<6;i++){if(!p)break;const c=(p.className||'').toString();if(c.includes('field')||c.includes('Field')||p.tagName==='LI'||p.tagName==='SECTION')return p;p=p.parentElement;}return el.parentElement; });
                const trig = await fc.$('[class*="css-"][class*="control"],[role="combobox"],div[class*="Select"],div[class*="select__control"]').catch(() => null);
                if (trig && await trig.isVisible().catch(() => false)) {
                  try {
                    const hs2 = await fc.$('select');
                    if (hs2) {
                      const opts = await hs2.$$eval('option', os => os.map(o => o.textContent.trim()));
                      const m = opts.find(o => o.toLowerCase().includes(dropAns.toLowerCase()) || (dropAns==='No'&&o.toLowerCase()==='no') || (dropAns==='Yes'&&o.toLowerCase()==='yes') || (dropAns==='Decline'&&o.toLowerCase().includes('decline')));
                      if (m) { await hs2.selectOption({ label: m }); await hs2.evaluate(el => el.dispatchEvent(new Event('change',{bubbles:true}))); continue; }
                    }
                  } catch(e2) {}
                  await trig.scrollIntoViewIfNeeded(); await trig.click({ timeout: 3000, force: true }); await page.waitForTimeout(600);
                  const opts = await page.$$('[role="option"],[class*="option"],ul[role="listbox"] li');
                  let picked = false;
                  for (const opt of opts) {
                    const ot = (await opt.innerText().catch(() => '')).toLowerCase().trim();
                    if (ot.includes(dropAns.toLowerCase()) || (dropAns==='Decline'&&(ot.includes('decline')||ot.includes('not wish')||ot.includes('prefer not'))) || (dropAns==='No'&&(ot==='no'||ot.startsWith('no,'))) || (dropAns==='Yes'&&(ot==='yes'||ot.startsWith('yes,'))) || (dropAns==='California'&&ot.includes('california')) || (dropAns==='LinkedIn'&&ot.includes('linkedin')) || (dropAns==='I am not a protected veteran'&&ot.includes('not a protected')) || (dropAns==='No, I do not have a disability'&&ot.includes('do not have'))) {
                      await opt.click({ timeout: 1500 }); picked = true; break;
                    }
                  }
                  if (!picked && opts.length > 0) for (const opt of opts) { const ot = (await opt.innerText().catch(() => '')).trim(); if (ot && !ot.toLowerCase().includes('select') && !ot.toLowerCase().includes('choose')) { await opt.click({ timeout: 1500 }); break; } }
                  await page.waitForTimeout(200);
                }
              } catch(e) {}
            }
          } else {
            const ans = getTextAnswer(rawLabel) || (() => {
              const responses = job.generated_responses || {};
              const cn = (job.company || '').toLowerCase();
              for (const [q, a] of Object.entries(responses)) {
                if (rawLabel.toLowerCase().includes(q.toLowerCase().slice(0, 20))) {
                  const as = String(a).toLowerCase();
                  const bad = ['anthropic','faire','intercom','figma','affirm','gusto','chime','verkada','mixpanel','amplitude','wonderschool','loop','waymo','ramp'].some(c => c !== cn && as.includes(c));
                  if (!bad) return String(a);
                }
              }
              return 'Please see my attached resume for details.';
            })();
            await el.fill((ans || '').slice(0, 500));
          }
        }
      }
    } catch(e) { log('  ⚠ Form handler: ' + e.message); }

    // EEOC fields
    try {
      for (const lbl of await page.$$('label')) {
        const lt = (await lbl.textContent().catch(() => '')).toLowerCase().trim();
        if (!lt || !/gender|race|ethnic|disability|veteran|lgbtq|pronoun|transgender/.test(lt)) continue;
        const fa = await lbl.getAttribute('for'); if (!fa) continue;
        const cont = await lbl.evaluateHandle(el => { let p=el.parentElement;for(let i=0;i<5;i++){if(!p)break;if(p.children.length>1)return p;p=p.parentElement;}return el.parentElement; });
        const trig = await cont.$('[class*="css-"][class*="control"],[role="combobox"]').catch(() => null);
        if (trig && await trig.isVisible().catch(() => false)) {
          await trig.click({ timeout: 2000, force: true }); await page.waitForTimeout(600);
          const opts = await page.$$('[role="option"]'); let picked = false;
          for (const opt of opts) { const t = (await opt.innerText().catch(() => '')).toLowerCase(); if (t.includes('decline')||t.includes('not wish')||t.includes('prefer not')||t.includes('do not have')||t.includes('not a protected')) { await opt.click({ timeout: 1500 }); picked = true; break; } }
          if (!picked && opts.length > 0) await opts[opts.length-1].click({ timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(300);
        }
      }
    } catch(e) {}

    for (const f of ['gender','hispanic_ethnicity','veteran_status','disability_status']) {
      try {
        const el = await page.$(`[id="${f}"]`); if (!el) continue;
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        if (tag === 'select') await el.selectOption({ index: 1 }).catch(() => {});
        else { await el.click().catch(() => {}); await page.waitForTimeout(400); const opts = await page.$$('[role="option"],ul li,[class*="option"]'); for (const opt of opts) { const t=(await opt.innerText().catch(()=>'')).toLowerCase(); if(t.includes('decline')||t.includes('not wish')||t.includes('not a protected')||t.includes('do not have')){await opt.click();break;} } }
      } catch(e) {}
    }

    try { for (const lbl of await page.$$('label')) { const t=(await lbl.innerText()||'').toLowerCase(); if(t.includes('decline to self-identify')||t.includes('prefer not to say'))await lbl.click(); } } catch(e) {}

    // Submit
    const submitBtn = page.locator('#submit_app, input[type="submit"][value*="Submit" i], button[type="submit"]').first();
    if (await submitBtn.count() === 0) return { success: false, message: 'Submit button not found' };

    const successPromise = Promise.any([
      page.waitForRequest(req => req.url().includes(`/v1/boards/${slug}/jobs/${jobId}/application`) && req.method() === 'POST', { timeout: 15000 }),
      page.waitForNavigation({ url: u => u.includes('confirmation'), waitUntil: 'domcontentloaded', timeout: 15000 }),
    ]).catch(() => null);

    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));
    const submitEl = await submitBtn.elementHandle().catch(() => null);
    if (submitEl) await humanizedClick(page, submitEl);
    else await submitBtn.click({ delay: 100 }).catch(() => {});
    log(`  🖱 Submitting...`);

    const result = await successPromise;
    const afterUrl = page.url();
    const pageText = await page.textContent('body').catch(() => '');

    if (pageText.match(/already applied|already submitted|previously applied/i)) return { duplicate: true, message: 'Already applied' };
    if (result) return { success: true, message: afterUrl.includes('confirmation') ? 'Submitted via Greenhouse ✓ (confirmed)' : 'Submitted via Greenhouse ✓ (POST intercepted)' };
    if (pageText.match(/thank you|application received|we received/i)) return { success: true, message: 'Submitted via Greenhouse ✓ (DOM)' };
    if (afterUrl.includes('confirmation')) return { success: true, message: 'Submitted via Greenhouse ✓ (URL)' };

    // Security code gate
    try {
      const si = page.locator('input[id*="verification"],input[id*="security"],input[name*="code"],input[placeholder*="code" i]');
      if (await si.count() > 0 && await si.isVisible().catch(() => false)) {
        log('  🔒 Security code gate — polling Gmail...');
        const code = await pollForSecurityCode();
        if (code) { await si.fill(code); await page.waitForTimeout(500); const rb = page.locator('button[type="submit"],input[type="submit"]').first(); if (await rb.count() > 0) await rb.click(); await page.waitForTimeout(3000); }
      }
    } catch(e) {}

    const ve = await page.evaluate(() => [...document.querySelectorAll('.error,.field-error,[class*="error"],[class*="invalid"]')].map(e => e.textContent?.trim()).filter(t => t && t.length > 0).slice(0, 10)).catch(() => []);
    if (ve.length > 0) { log(`  📋 Validation: ${ve.join(' | ')}`); return { success: false, message: `Validation: ${ve.slice(0,3).join(', ')}` }; }

    await page.screenshot({ path: '/tmp/greenhouse-debug.png', fullPage: true }).catch(() => {});
    return { success: false, message: `No confirmation at ${afterUrl}` };
  } catch(err) { return { success: false, message: `Greenhouse error: ${err.message}` }; }
}

module.exports = { submitGreenhouse };

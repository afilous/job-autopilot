/**
 * ats/ashby.js — Ashby application handler
 */

const { PROFILE, ESSAY_ANSWERS } = require('../lib/profile');
const { fillReactField, humanizedClick, tryFillByLabel } = require('../lib/helpers');
const { uploadResume } = require('../lib/resume');
const { handleCaptcha } = require('../lib/captcha');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function submitAshby(page, job, resumeText, resumePdfUrl) {
  try {
    const applyUrl = job.url.includes('/application') ? job.url : `${job.url}/application`;
    log(`  🌐 ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalDomain = new URL(page.url()).hostname;
    if (!finalDomain.includes('ashbyhq.com')) return { success: false, manual: true, message: `Custom site: ${finalDomain}` };

    log('  📝 Filling Ashby form...');

    const ESSAY_ANSWER = ESSAY_ANSWERS.proud;

    // ── Fill all inputs ───────────────────────────────────────────────────────
    try {
      const formInputs = await page.$$('input,textarea,[contenteditable="true"]');
      for (const input of formInputs) {
        await Promise.race([
          (async () => {
            try {
              const isVisible = await input.isVisible().catch(() => false);
              if (!isVisible) return;
              const inputType = await input.getAttribute('type').catch(() => '');
              if (['file','hidden','submit','checkbox','radio'].includes(inputType)) return;

              const inputId = await input.getAttribute('id').catch(() => '') || '';
              const inputName = await input.getAttribute('name').catch(() => '') || '';
              const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}/i;
              if (uuidPattern.test(inputId) || uuidPattern.test(inputName)) {
                log('  ⚠ UUID honeypot: ' + inputId.slice(0, 20)); return;
              }

              // System fields — pierce React state with nativeInputValueSetter
              if (inputId === '_systemfield_name' || inputName === '_systemfield_name') {
                await fillReactField(page, input, PROFILE.full_name);
                log('  ✓ System name: ' + (await input.evaluate(el => el.value).catch(() => '?'))); return;
              }
              if (inputId === '_systemfield_email' || inputName === '_systemfield_email') {
                await fillReactField(page, input, PROFILE.email);
                log('  ✓ System email: ' + (await input.evaluate(el => el.value).catch(() => '?'))); return;
              }
              if (inputId === '_systemfield_phone' || inputName === '_systemfield_phone') {
                await fillReactField(page, input, PROFILE.phone_formatted);
                log('  ✓ System phone: ' + (await input.evaluate(el => el.value).catch(() => '?'))); return;
              }
              if (inputId === '_systemfield_linkedin' || inputName === '_systemfield_linkedin') {
                await fillReactField(page, input, PROFILE.linkedin);
                log('  ✓ System LinkedIn'); return;
              }

              const isHoneypot = await input.evaluate(el => {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0 || r.width < 5 || r.height < 5) return true;
                const s = window.getComputedStyle(el);
                return s.opacity === '0' || s.display === 'none' || s.visibility === 'hidden';
              }).catch(() => false);
              if (isHoneypot) return;

              const meta = await input.evaluate(el => {
                const parent = el.closest('[class*="field"],[class*="form"],label,li,div') || el.parentElement;
                const lbl = document.querySelector(`label[for="${el.id}"]`);
                return [
                  el.getAttribute('placeholder') || '',
                  el.getAttribute('aria-label') || '',
                  el.getAttribute('name') || '',
                  el.getAttribute('id') || '',
                  lbl?.innerText || '',
                  parent?.innerText?.slice(0, 100) || ''
                ].join(' ').toLowerCase();
              }).catch(() => '');

              const currentVal = await input.evaluate(el => el.value || '').catch(() => '');
              let fillVal = null;

              if (/\bfull.?name\b/.test(meta) || (/\bname\b/.test(meta) && !meta.includes('company') && !meta.includes('employer') && !meta.includes('file') && !meta.includes('school') && !meta.includes('hear') && meta.length < 200)) {
                fillVal = meta.includes('first') ? PROFILE.first_name : meta.includes('last') ? PROFILE.last_name : meta.includes('middle') ? '' : PROFILE.full_name;
              }
              else if (/\bemail\b/.test(meta) && meta.length < 200) fillVal = PROFILE.email;
              else if (/\bphone\b|\btel\b|phone number/.test(meta) && meta.length < 200) fillVal = PROFILE.phone_formatted;
              else if (/linkedin/.test(meta)) { const li = PROFILE.linkedin; fillVal = li.startsWith('http') ? li : 'https://' + li; }
              else if (/\bwebsite\b|\bportfolio\b/.test(meta)) fillVal = PROFILE.website;
              else if (/how did you hear|where did you|referral source|find this job|job posting/.test(meta)) fillVal = 'LinkedIn';
              else if (/country.*reside|country.*currently|currently.*reside/.test(meta)) fillVal = 'United States';
              else if (/country/.test(meta) && meta.length < 100) fillVal = 'United States';
              else if (/require.*sponsor|sponsor.*work|visa.*sponsor/.test(meta)) fillVal = 'No';
              else if (/your pronouns|pronouns/.test(meta)) fillVal = 'He/Him';
              else if (/legal.*first.*last|legal.*name|full.*legal/.test(meta)) fillVal = PROFILE.full_name;
              else if (/preferred.*first|first.*preferred/.test(meta)) fillVal = PROFILE.first_name;
              else if (/preferred.*last|last.*preferred/.test(meta)) fillVal = PROFILE.last_name;
              else if (/current.*employer|most recent.*employer/.test(meta)) fillVal = 'Stealth Startup';
              else if (/location|city.*country|country.*city/.test(meta) && meta.length < 80) fillVal = 'San Mateo, CA, United States';
              else if (/current.*company|most recent.*company/.test(meta)) fillVal = 'Stealth Startup';
              else if (/salary|compensation|expected.*pay|pay.*expect/.test(meta)) fillVal = '145000 USD';
              else if (/notice period|notice.*period/.test(meta)) fillVal = 'Immediately available';
              else if (/relative|family member|spouse|partner/.test(meta)) fillVal = '';
              else if (/proud of|exceptional|impressive|something you/.test(meta)) fillVal = ESSAY_ANSWER;
              else if (/what excites you|why.*want.*work|why do you want|why.*company|why.*role|why.*join|why.*interest|most excit|drawn to/.test(meta)) fillVal = ESSAY_ANSWERS.why_company;
              else if (/messy.*ambiguous|hardest part/.test(meta)) fillVal = ESSAY_ANSWERS.ambiguous;
              else if (/beyond your title|went beyond|no one asked/.test(meta)) fillVal = ESSAY_ANSWERS.beyond_title;
              else if (/program.*end.to.end|execute.*program/.test(meta)) fillVal = ESSAY_ANSWERS.program;
              else if (/measure success|metrics.*mattered/.test(meta)) fillVal = ESSAY_ANSWERS.metrics;
              else if (/anything else|additional information/.test(meta)) fillVal = 'Please see my attached resume for additional details.';
              else if (/notice period|earliest.*start|when.*available/.test(meta)) fillVal = 'Immediately';
              else if (/previously.*employed|former.*employee/.test(meta)) fillVal = 'No';
              else if (await input.evaluate(el => el.tagName.toLowerCase() === 'textarea').catch(() => false)) {
                // Textarea catch-all — fill with essay answer
                fillVal = ESSAY_ANSWER;
              }

              if (fillVal !== null && fillVal !== currentVal) {
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
                  if (!confirmed && fillVal.length > 0) {
                    await input.fill('');
                    await input.type(fillVal.slice(0, 200), { delay: 20 });
                  }
                } catch(fe2) {
                  await input.evaluate((el, val) => {
                    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                    if (s) s.call(el, val); else el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                  }, fillVal).catch(() => {});
                }
                log('  ✓ Filled: ' + meta.slice(0, 40).trim());
              }
            } catch(fe) {}
          })(),
          new Promise(resolve => setTimeout(resolve, 5000))
        ]);
      }
    } catch(e) { log('  ⚠ Field interceptor: ' + e.message.slice(0, 50)); }

    // ── getByLabel sweep — catches fields missed by input loop ────────────────
    try {
      const labelMap = [
        ['full name', PROFILE.full_name],
        ['first name', PROFILE.first_name],
        ['last name', PROFILE.last_name],
        ['email', PROFILE.email],
        ['phone', PROFILE.phone_formatted],
        ['linkedin', PROFILE.linkedin],
        ['location', 'San Mateo, CA, United States'],
        ['salary', '145000 USD'],
        ['notice period', 'Immediately available'],
        ['where did you find', 'LinkedIn'],
        ['how did you hear', 'LinkedIn'],
      ];
      for (const [label, value] of labelMap) {
        try {
          const el = page.getByLabel(label, { exact: false }).first();
          if (await el.count() === 0) continue;
          if (!await el.isVisible().catch(() => false)) continue;
          const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => '');
          if (tag === 'select') continue; // handled separately
          const current = await el.inputValue().catch(() => '');
          if (current && current.length > 2) continue; // already filled
          await el.fill(value);
          await el.evaluate(e => {
            e.dispatchEvent(new Event('input', { bubbles: true }));
            e.dispatchEvent(new Event('change', { bubbles: true }));
          });
          log(`  ✓ getByLabel "${label}": ${value.slice(0, 30)}`);
        } catch(e) {}
      }
    } catch(e) {}

    // ── Phone sweep ───────────────────────────────────────────────────────────
    try {
      let phoneFilled = false;
      for (const sel of ['input[name="_systemfield_phone"]','input[id="_systemfield_phone"]','input[type="tel"]','input[placeholder*="phone" i]','input[aria-label*="phone" i]','input[autocomplete="tel"]']) {
        const pi = await page.$(sel).catch(() => null);
        if (!pi || !await pi.isVisible().catch(() => false)) continue;
        const ex = await pi.evaluate(el => el.value).catch(() => '');
        if (ex && ex.length > 5) { phoneFilled = true; break; }
        await fillReactField(page, pi, PROFILE.phone_formatted);
        log('  ✓ Phone sweep: ' + (await pi.evaluate(el => el.value).catch(() => '?')));
        phoneFilled = true; break;
      }
      if (!phoneFilled) log('  ⚠ Phone not found');
    } catch(e) {}

    // ── Consent checkboxes ────────────────────────────────────────────────────
    try {
      for (const cb of await page.$$('input[type="checkbox"]')) {
        if (await cb.isChecked().catch(() => true)) continue;
        const lbl = await cb.evaluate(el => {
          const l = document.querySelector(`label[for="${el.id}"]`);
          return (l?.innerText || el.closest('label')?.innerText || '').toLowerCase();
        }).catch(() => '');
        if (/sms|text message|marketing|promotional/.test(lbl)) continue;
        if (/confidential|privacy policy|terms|acknowledge|agree|certify|consent/.test(lbl) || lbl === '') {
          await cb.evaluate(el => el.click());
        }
      }
    } catch(e) {}

    // ── Resume upload ─────────────────────────────────────────────────────────
    if (resumePdfUrl) {
      await uploadResume(page, ['input[type="file"]']);
      try {
        const fi = await page.$('input[type="file"]');
        if (fi) {
          await fi.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
          });
          log('  📎 File change event dispatched');
        }
      } catch(e) {}
    }

    // ── Custom question answers from Supabase ─────────────────────────────────
    const answers = job.generated_responses || {};
    for (const [q, a] of Object.entries(answers)) await tryFillByLabel(page, q, String(a));

    await page.waitForTimeout(Math.floor(Math.random() * 800 + 400));

    // ── Yes/No button handler ─────────────────────────────────────────────────
    // Ashby renders Yes/No questions as <button> elements, not radio inputs.
    // We find ALL visible buttons with text "Yes" or "No" and click based on
    // the surrounding question text context.
    try {
      const allButtons = await page.$$('button');
      for (const btn of allButtons) {
        const btnText = (await btn.innerText().catch(() => '')).trim();
        if (btnText !== 'Yes' && btnText !== 'No') continue;
        if (!await btn.isVisible().catch(() => false)) continue;

        // Check if already selected (has a distinct style vs unselected)
        const isSelected = await btn.evaluate(el => {
          return el.getAttribute('aria-pressed') === 'true' ||
            el.getAttribute('aria-selected') === 'true' ||
            el.getAttribute('data-selected') === 'true' ||
            el.getAttribute('data-state') === 'on' ||
            el.getAttribute('data-state') === 'active';
        }).catch(() => false);
        if (isSelected) continue;

        // Get surrounding question text
        const questionText = await btn.evaluate(el => {
          let p = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!p) break;
            if (p.innerText && p.innerText.length > 15) return p.innerText.toLowerCase();
            p = p.parentElement;
          }
          return '';
        }).catch(() => '');

        // Determine correct answer
        const shouldPickNo = /sponsor|visa|relative|family member|currently work|worked.*before|former.*employee|ai tool|use.*ai|artificial intel/.test(questionText);
        const shouldPickYes = /in.person|in-person|office|hybrid|relocat|authorized|eligible|legally|agree|acknowledge|understand|policy|read.*agree|indicate.*yes/.test(questionText);

        if (btnText === 'No' && shouldPickNo) {
          await btn.click();
          log(`  ✓ Clicked No: "${questionText.slice(0, 60)}"`);
          await page.waitForTimeout(300);
        } else if (btnText === 'Yes' && shouldPickYes) {
          await btn.click();
          log(`  ✓ Clicked Yes: "${questionText.slice(0, 60)}"`);
          await page.waitForTimeout(300);
        }
      }
    } catch(e) { log('  ⚠ Yes/No buttons: ' + e.message.slice(0, 50)); }

    // ── "How did you hear" combobox ───────────────────────────────────────────
    try {
      for (const cb of await page.$$('[role="combobox"]')) {
        if (!await cb.isVisible().catch(() => false)) continue;
        const pt = await cb.evaluate(el => {
          let p = el.parentElement;
          for (let i = 0; i < 5; i++) { if (!p) break; if (p.innerText?.length > 5) return p.innerText.toLowerCase(); p = p.parentElement; }
          return '';
        }).catch(() => '');
        if (/how did you hear|where did you|referral|source|find.*job|job.*posting/.test(pt)) {
          await cb.click().catch(() => {}); await new Promise(r => setTimeout(r, 500));
          const opts = await page.$$('[role="option"]');
          for (const opt of opts) {
            const t = (await opt.innerText().catch(() => '')).toLowerCase();
            if (t.includes('linkedin') || t.includes('other') || t.includes('job board')) {
              await opt.click().catch(() => {}); break;
            }
          }
        }
      }
    } catch(e) {}

    // ── CAPTCHA check ─────────────────────────────────────────────────────────
    const ashbyCaptcha = await page.$('#h-captcha,.h-captcha,iframe[src*="hcaptcha"]').catch(() => null);
    if (ashbyCaptcha) {
      log('  🧩 CAPTCHA — attempting solve...');
      const solved = await handleCaptcha(page);
      if (!solved) return { success: false, manual: true, message: 'CAPTCHA wall detected' };
      await page.waitForTimeout(2000);
    }

    // ── Pre-submit: empty native dropdowns ────────────────────────────────────
    try {
      const sels = await page.$$('select');
      for (const s of sels) {
        const v = await s.evaluate(el => el.value).catch(() => '');
        if (!v) await s.selectOption({ index: 1 }).catch(() => {});
      }
    } catch(e) {}

    // ── Multi-step check ──────────────────────────────────────────────────────
    try {
      const se = await page.$('button:has-text("Submit Application"),button[type="submit"]');
      if (!se) {
        const nb = await page.$('button:has-text("Next"),button:has-text("Continue")');
        if (nb && await nb.isVisible().catch(() => false)) {
          log('  👉 Multi-step — Next'); await nb.click(); await page.waitForTimeout(1500);
        }
      }
    } catch(e) {}

    // ── Network promises ──────────────────────────────────────────────────────
    const ashbyPromise = Promise.any([
      page.waitForResponse(res => res.url().includes('/api/non-auth/v1/postings/') && res.url().includes('/apply') && res.status() === 200, { timeout: 15000 }),
      page.waitForNavigation({ url: u => u.includes('/application/success'), waitUntil: 'domcontentloaded', timeout: 15000 }),
    ]).catch(() => null);

    const networkPromise = page.waitForResponse(resp => {
      const u = resp.url();
      return u.includes('ashbyhq.com') && (u.includes('/application') || u.includes('/apply') || u.includes('/submit')) && resp.request().method() === 'POST';
    }, { timeout: 15000 }).catch(() => null);

    // ── Find submit button — grab element handle ONCE upfront ─────────────────
    const ashbyBtnSelectors = [
      'button[type="submit"]',
      'button:has-text("Submit Application")',
      'button:has-text("Submit application")',
      'button:has-text("Submit")',
      'button:has-text("Apply Now")',
      'button:has-text("Apply now")',
      'button:has-text("Apply")',
    ];
    let ashbyBtnEl = null;
    for (const sel of ashbyBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
        ashbyBtnEl = await btn.elementHandle().catch(() => null);
        if (ashbyBtnEl) { log(`  🔘 Found: ${sel}`); break; }
      }
    }

    if (!ashbyBtnEl) {
      const allBtns = await page.$$('button');
      const btnTexts = await Promise.all(allBtns.map(b => b.innerText().catch(() => '')));
      log(`  ⚠ No submit button. Buttons: ${btnTexts.filter(Boolean).join(' | ').slice(0, 100)}`);
    } else {
      await ashbyBtnEl.scrollIntoViewIfNeeded();
      await ashbyBtnEl.focus().catch(() => {});
      await page.waitForTimeout(300);

      // Strategy 1: Enter key on focused button
      log(`  🖱 Tab+Enter...`);
      await ashbyBtnEl.focus().catch(() => {});
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);

      // Strategy 2: form.requestSubmit()
      if (page.url().includes('/application') && !page.url().includes('success')) {
        log(`  🔄 form.requestSubmit()...`);
        const ok = await page.evaluate(() => {
          const f = document.querySelector('form');
          if (!f) return false;
          try { f.requestSubmit(); return true; } catch(e) { f.submit(); return true; }
        }).catch(() => false);
        log(`  📋 requestSubmit: ${ok}`);
        await page.waitForTimeout(800);
      }

      // Strategy 3: humanized click
      if (page.url().includes('/application') && !page.url().includes('success')) {
        log(`  🔄 Humanized click...`);
        await humanizedClick(page, ashbyBtnEl);
        await page.waitForTimeout(500);
      }

      // Strategy 4: React pointer events
      if (page.url().includes('/application') && !page.url().includes('success')) {
        log(`  🔄 React pointer events...`);
        await ashbyBtnEl.evaluate(btn => {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isTrusted: true }));
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, isTrusted: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, isTrusted: true }));
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, isTrusted: true }));
        }).catch(() => {});
      }
    }

    // ── Check results ─────────────────────────────────────────────────────────
    const networkResp = await networkPromise;
    if (networkResp) {
      log(`  📡 Network: ${networkResp.status()} from ${networkResp.url().slice(0, 60)}`);
      if (networkResp.status() >= 400) return { success: false, message: `Ashby rejected: ${networkResp.status()}` };
    } else {
      log(`  📡 No POST detected`);
    }

    const ashbyResult = await ashbyPromise;
    const ashbyUrl = page.url();
    log(`  📍 ${ashbyUrl}`);

    if (ashbyResult || ashbyUrl.includes('/application/success') || ashbyUrl.includes('/thanks') || ashbyUrl.includes('/confirmation')) {
      return { success: true, message: 'Submitted via Ashby ✓' };
    }

    const se2 = await page.$('[class*="successPage" i],h1:has-text("Thank You"),h1:has-text("Application Submitted")').catch(() => null);
    if (se2) return { success: true, message: 'Submitted via Ashby ✓ (success element)' };

    log(`  ⚠ Still on /application`);
    const errs = [];
    for (const sel of ['div[class*="_error"]','[aria-invalid="true"]','span[class*="error"]','[class*="error"]','[class*="invalid"]']) {
      const els = await page.$$(sel);
      for (const el of els) {
        const t = (await el.textContent().catch(() => '')).trim();
        if (t && t.length > 2 && !errs.includes(t)) errs.push(t);
      }
    }
    log(`  📋 Ashby errors: ${errs.length > 0 ? errs.slice(0, 5).join(' | ') : '(none)'}`);
    await page.screenshot({ path: '/tmp/ashby-debug.png', fullPage: true }).catch(() => {});
    return { success: false, message: `Ashby: no confirmation at ${ashbyUrl}` };

  } catch(err) { return { success: false, message: `Ashby error: ${err.message}` }; }
}

module.exports = { submitAshby };

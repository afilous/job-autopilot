/**
 * ats/ashby.js — Ashby application handler
 */

const { PROFILE, ESSAY_ANSWERS } = require('../lib/profile');
const { humanizedClick, tryFillByLabel } = require('../lib/helpers');
const { uploadResume } = require('../lib/resume');
const { handleCaptcha } = require('../lib/captcha');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Fill a React controlled input reliably:
// - Short values (<=100 chars): keyboard.type() character by character
// - Long values (>100 chars): clipboard paste via DataTransfer, with native setter fallback
async function fillAshbyField(page, input, value) {
  if (!value) return;
  try {
    await input.scrollIntoViewIfNeeded();
    await input.click({ clickCount: 3 });
    await page.waitForTimeout(100);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(50);

    if (value.length <= 100) {
      await page.keyboard.type(value, { delay: 35 });
    } else {
      // Paste via clipboard event
      await input.evaluate((el, val) => {
        const dt = new DataTransfer();
        dt.setData('text/plain', val);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, value);
      await page.waitForTimeout(100);

      // If paste didn't register, fall back to native setter
      const confirmed = await input.evaluate(el => el.value || '').catch(() => '');
      if (!confirmed || confirmed.length < 10) {
        await input.evaluate((el, val) => {
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
      }
    }

    // Always fire events after filling
    await input.evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    });
    await page.waitForTimeout(80);
  } catch(e) {
    log('  ⚠ fillAshbyField: ' + e.message.slice(0, 60));
  }
}

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

              // System fields
              if (inputId === '_systemfield_name' || inputName === '_systemfield_name') {
                await fillAshbyField(page, input, PROFILE.full_name);
                log('  ✓ name: ' + (await input.evaluate(el => el.value).catch(() => '?'))); return;
              }
              if (inputId === '_systemfield_email' || inputName === '_systemfield_email') {
                await fillAshbyField(page, input, PROFILE.email);
                log('  ✓ email: ' + (await input.evaluate(el => el.value).catch(() => '?'))); return;
              }
              if (inputId === '_systemfield_phone' || inputName === '_systemfield_phone') {
                await fillAshbyField(page, input, PROFILE.phone_formatted);
                log('  ✓ phone: ' + (await

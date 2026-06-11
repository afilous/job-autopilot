/**
 * lib/helpers.js — Shared page interaction utilities
 */

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Force value into React controlled input via nativeInputValueSetter
async function fillReactField(page, input, value) {
  await input.focus();
  await input.click({ clickCount: 3 });
  await page.keyboard.type(value, { delay: 40 });
  await input.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }, value);
  await page.waitForTimeout(50 + Math.floor(Math.random() * 50));
}

// Human-like typing with random delays
async function humanType(page, selector, value) {
  if (!value) return false;
  try {
    const el = await page.$(selector);
    if (!el) return false;
    await el.click(); await el.fill('');
    for (const c of value) {
      await page.keyboard.type(c);
      await page.waitForTimeout(Math.floor(Math.random() * 40 + 10));
    }
    await page.waitForTimeout(Math.floor(Math.random() * 200 + 100));
    return true;
  } catch(e) { return false; }
}

// Clear and type with human delay — used after Lever resume parse
async function clearAndType(page, selector, value) {
  if (!value) return false;
  try {
    const el = await page.$(selector);
    if (!el || !await el.isVisible().catch(() => false)) return false;
    await el.scrollIntoViewIfNeeded();
    await el.click({ clickCount: 3 });
    await el.type(value, { delay: 50 + Math.floor(Math.random() * 50) });
    await el.evaluate(e => {
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      e.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    return true;
  } catch(e) { return false; }
}

// Fill from list of selectors
async function fillField(page, selectors, value) {
  if (!value) return false;
  for (const sel of selectors) {
    try { const el = await page.$(sel); if (el) { await el.fill(value); return true; } } catch(e) {}
  }
  return false;
}

// Humanized mouse click — drifts pointer naturally
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

// Handle radio buttons by label text
async function handleRadioByText(page, questionRegex, answerRegex) {
  try {
    const fieldBlock = page.locator('div.field', { hasText: questionRegex });
    if (await fieldBlock.count() === 0) return false;
    const label = fieldBlock.locator('label', { hasText: answerRegex });
    if (await label.count() > 0) { await label.first().click(); return true; }
  } catch(e) {}
  return false;
}

// Handle select dropdowns by label text
async function handleDropdownByText(page, questionRegex, value) {
  try {
    const fieldBlock = page.locator('div.field', { hasText: questionRegex });
    if (await fieldBlock.count() === 0) return false;
    const select = fieldBlock.locator('select');
    if (await select.count() > 0) {
      await select.first().selectOption({ label: value }).catch(() =>
        select.first().selectOption({ value: value.toLowerCase() }).catch(() => {}));
      return true;
    }
  } catch(e) {}
  return false;
}

// Fill field by matching label text
async function tryFillByLabel(page, labelText, value) {
  if (!value || !labelText) return false;
  try {
    for (const label of await page.$$('label')) {
      const text = await label.textContent();
      if (text && text.toLowerCase().includes(labelText.toLowerCase().slice(0, 25))) {
        const forAttr = await label.getAttribute('for');
        if (forAttr) {
          const input = await page.$(`[id="${forAttr}"]`);
          if (input) {
            const tag = await input.evaluate(el => el.tagName.toLowerCase());
            const type = await input.evaluate(el => el.type || '');
            if (tag === 'textarea' || (tag === 'input' && !['radio','checkbox','file','hidden'].includes(type))) {
              await input.fill(value); return true;
            }
            if (tag === 'select') { await input.selectOption({ label: value }).catch(() => {}); return true; }
          }
        }
      }
    }
  } catch(e) {}
  return false;
}

module.exports = { fillReactField, humanType, clearAndType, fillField, humanizedClick, handleRadioByText, handleDropdownByText, tryFillByLabel };

/**
 * lib/resume.js — Resume download, caching, and upload
 */

const fs = require('fs');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

const RESUME_PATH = '/tmp/aaron_resume.pdf';

// Download resume PDF from Supabase storage, cache locally
async function ensureResumeCached(pdfUrl) {
  if (!pdfUrl) { log('  ⚠ No resume PDF URL'); return false; }

  if (fs.existsSync(RESUME_PATH) && fs.statSync(RESUME_PATH).size > 0) {
    log(`  📎 Using cached resume (${fs.statSync(RESUME_PATH).size} bytes)`);
    return true;
  }

  log('  📥 Downloading resume...');
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(pdfUrl, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) { log(`  ⚠ Download failed: ${res.status}`); return false; }
    fs.writeFileSync(RESUME_PATH, Buffer.from(await res.arrayBuffer()));
    log(`  💾 Resume cached: ${fs.statSync(RESUME_PATH).size} bytes`);
    return true;
  } catch(e) {
    clearTimeout(timeout);
    log(`  ⚠ Download error: ${e.message.slice(0,40)}`);
    return false;
  }
}

// Upload resume to file input on page, fire React change events
async function uploadResume(page, selectors) {
  if (!fs.existsSync(RESUME_PATH) || fs.statSync(RESUME_PATH).size === 0) {
    log('  ⚠ Resume file missing');
    return false;
  }

  for (const sel of selectors) {
    const fi = await page.$(sel).catch(() => null);
    if (!fi) continue;
    await fi.setInputFiles(RESUME_PATH);
    // Fire change events so React registers the file
    await fi.evaluate(el => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(1500);
    log('  ✅ Resume uploaded');
    return true;
  }

  log('  ⚠ No file input found');
  return false;
}

module.exports = { ensureResumeCached, uploadResume, RESUME_PATH };

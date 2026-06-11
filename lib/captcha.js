/**
 * lib/captcha.js — CapSolver CAPTCHA solving integration
 */

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY || null;
const CAPSOLVER_API = 'https://api.capsolver.com';

// Solve hCaptcha using CapSolver
async function solveHCaptcha(siteKey, pageUrl) {
  if (!CAPSOLVER_API_KEY) {
    log('  ⚠ CAPSOLVER_API_KEY not set — cannot solve CAPTCHA');
    return null;
  }

  log(`  🧩 Solving hCaptcha via CapSolver...`);

  try {
    // Create task
    const createRes = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: CAPSOLVER_API_KEY,
        task: {
          type: 'HCaptchaTaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        },
      }),
    });
    const createData = await createRes.json();
    if (createData.errorId > 0) {
      log(`  ⚠ CapSolver create task error: ${createData.errorDescription}`);
      return null;
    }

    const taskId = createData.taskId;
    log(`  🧩 Task created: ${taskId} — polling for solution...`);

    // Poll for result
    const startTime = Date.now();
    while (Date.now() - startTime < 120000) {
      await new Promise(r => setTimeout(r, 3000));
      const resultRes = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId }),
      });
      const resultData = await resultRes.json();

      if (resultData.status === 'ready') {
        log(`  ✅ CAPTCHA solved`);
        return resultData.solution.gRecaptchaResponse;
      }
      if (resultData.errorId > 0) {
        log(`  ⚠ CapSolver error: ${resultData.errorDescription}`);
        return null;
      }
    }

    log('  ⚠ CapSolver timeout — no solution after 120s');
    return null;
  } catch(e) {
    log(`  ⚠ CapSolver exception: ${e.message}`);
    return null;
  }
}

// Detect and solve CAPTCHA on page, inject token if solved
async function handleCaptcha(page) {
  try {
    // Check for hCaptcha
    const hCaptchaFrame = await page.$('iframe[src*="hcaptcha.com"]').catch(() => null);
    if (hCaptchaFrame) {
      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey], .h-captcha[data-sitekey]');
        return el ? el.getAttribute('data-sitekey') : null;
      }).catch(() => null);

      if (siteKey) {
        const token = await solveHCaptcha(siteKey, page.url());
        if (token) {
          // Inject the token into the page
          await page.evaluate((t) => {
            const textarea = document.querySelector('[name="h-captcha-response"], textarea[name="g-recaptcha-response"]');
            if (textarea) {
              textarea.value = t;
              textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
            // Also try the callback if defined
            if (window.hcaptcha) window.hcaptcha.execute();
          }, token);
          log('  ✅ hCaptcha token injected');
          return true;
        }
      }
    }

    // Check for reCaptcha
    const reCaptchaFrame = await page.$('iframe[src*="recaptcha"]').catch(() => null);
    if (reCaptchaFrame) {
      log('  ⚠ reCaptcha detected — CapSolver reCaptcha not yet implemented');
      return false;
    }

    return false; // No CAPTCHA found
  } catch(e) {
    log(`  ⚠ CAPTCHA handler error: ${e.message}`);
    return false;
  }
}

module.exports = { handleCaptcha, solveHCaptcha };

/**
 * lib/browser.js — Stealth browser launch, session warming, persistent context
 */

const { chromium: vanillaChromium } = require('playwright');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Load stealth browser with fallback chain
async function launchStealthBrowser() {
  let chromium;
  try {
    const { chromium: extraChromium } = require('playwright-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    extraChromium.use(StealthPlugin());
    chromium = extraChromium;
    log('[stealth] playwright-extra + stealth plugin loaded');
  } catch(e) {
    try {
      const { chromium: reChromium } = require('rebrowser-playwright');
      chromium = reChromium;
      log('[stealth] rebrowser-playwright loaded');
    } catch(e2) {
      chromium = vanillaChromium;
      log('[stealth] using vanilla playwright');
    }
  }

  const proxyUrl = process.env.PROXY_URL || null;

  const browser = await chromium.launch({
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

  return { browser, proxyUrl };
}

// Create a new browser context with full spoofing
async function createContext(browser, proxyUrl) {
  const context = await browser.newContext({
    bypassCSP: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    hasTouch: false,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  });

  return context;
}

// Create a page with resource blocking and error logging
async function createPage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);

  // Block images/media/fonts to save proxy bandwidth
  await page.route('**/*', route => {
    const t = route.request().resourceType();
    if (['image', 'media', 'font'].includes(t)) route.abort();
    else route.continue();
  });

  page.on('console', msg => { if (msg.type() === 'error') log(`  🖥 ${msg.text()}`); });
  page.on('pageerror', err => log(`  🖥 JS error: ${err.message}`));

  return page;
}

// Warm up browser session to build trust markers before hitting ATS portals
async function warmUpSession(page) {
  log('  🧼 Warming up browser session...');
  try {
    await page.goto('https://www.wikipedia.org', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
    await page.goto('https://news.ycombinator.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(1000 + Math.floor(Math.random() * 500));
    log('  ✓ Session warmed');
  } catch(e) {
    log('  ⚠ Warmup failed, proceeding anyway');
  }
}

module.exports = { launchStealthBrowser, createContext, createPage, warmUpSession };

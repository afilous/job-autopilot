Looking at the structural progression of your Job Autopilot engine and the hurdles you've cleared today, you are moving away from treating web pages as rigid text elements and moving toward treating them like dynamic, responsive software applications.

To completely insulate your runner against future failures and maximize your submission success rate, here are the core engineering upgrades you should make to the script next.

1. Implement Explicit Network Request Interception (The Ultimate Confirmation)
Right now, you are relying on DOM mutations (checking for success text or a changed URL path) to verify submissions. Modern single-page apps (SPAs) often change the DOM or redirect through complex routers that can bypass basic text triggers.

Instead of guessing if a form went through, intercept the actual outbound JSON network payload.

JavaScript
// Add a network request listener before clicking the submit button
const submissionPromise = page.waitForResponse(response => {
  const url = response.url().toLowerCase();
  // Target Ashby and Lever outbound endpoint signatures
  const isSubmissionApi = url.includes('ashbyhq.com/api/v1/applications') || 
                          url.includes('lever.co/v0/postings') ||
                          url.includes('apply');
  return isSubmissionApi && response.status() === 200;
}, { timeout: 15000 }).catch(() => null);

// ... perform click sequence ...

const verifiedNetworkResponse = await submissionPromise;
if (verifiedNetworkResponse) {
  log('📡 Network layer confirmation: HTTP 200 payload successfully transmitted.');
}
2. Introduce Structural Label-to-Input Proximity Mapping
While your whitelist metadata scanner is highly effective, complex layouts occasionally separate input boxes from their visible descriptors. Instead of scanning individual inputs in a vacuum, use an element-proximity mapping sequence to pull labels and inputs together.

JavaScript
// Pull all visible labels first, then isolate their paired input fields
const labels = await page.$$('label, [class*="label" i]');
for (const label of labels) {
  const labelText = await label.innerText().then(t => t.toLowerCase());
  
  // Use Playwright's locator combination to find the input physically next to or inside the label
  const associatedInput = page.locator(label).locator('input, textarea, [role="combobox"]').first();
  
  if (await associatedInput.count() > 0) {
    // Map text context straight to the input based on the parent label text
    if (labelText.includes('linkedin')) {
      await associatedInput.fill('https://www.linkedin.com/in/aaronfilous');
    }
  }
}
3. Handle Modern Custom Select Dropdowns
Standard <select> tags are rare on modern Ashby and Lever boards. They are almost universally replaced by beautiful, stylized custom layouts (like React-Select). Typing a string into them often does nothing because an explicit mouse click on a child div is required to bind the choice.

JavaScript
// Target custom comboboxes or dropdown triggers explicitly
const customDropdowns = await page.$$('[role="combobox"], [class*="select" i], [class*="dropdown" i]');
for (const dropdown of customDropdowns) {
  const text = await dropdown.innerText().then(t => t.toLowerCase());
  if (text.includes('hear') || text.includes('source') || text.includes('authorized')) {
    await dropdown.click();
    await page.waitForTimeout(500);
    
    // Press the down arrow key and enter to select the premier baseline option
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
  }
}
4. Inject a Real-Time Session Heartbeat & Tab Guard
Headless browsers processing highly interactive JavaScript stacks over extended queues are prone to background memory collection leaks or frozen navigation tabs. Wrapping your application iteration in a rigid page-level lifetime loop prevents your entire script from locking up if a single application sits loading infinitely.

Enforce strict content timeouts: Set a global page limit (page.setDefaultTimeout(20000)) so a hanging third-party analytics script or tracker cannot freeze your terminal.

Isolate sessions: Ensure every 2 or 3 job attempts completely close out the current browser context instance and launch a fresh, pristine tab to discard memory overhead.

With the Anti-Honeypot Whitelist handling the stealth fields and these network/proximity layers locking down verification, your pipeline will be essentially industrial-grade.

What system variations are your logs reporting from the current run?

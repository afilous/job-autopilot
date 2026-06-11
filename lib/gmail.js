/**
 * lib/gmail.js — Gmail OAuth polling for Greenhouse security codes
 */

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

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
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: `from:no-reply@us.greenhouse-mail.io after:${dayTimestamp}`,
          maxResults: 10,
        });
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

module.exports = { pollForSecurityCode };

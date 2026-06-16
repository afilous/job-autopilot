/**
 * lib/gmail.js — Gmail OAuth polling for Greenhouse security codes
 */

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function pollForSecurityCode() {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) return null;
  try {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const startTime = Date.now();

    while (Date.now() - startTime < 90000) {
      try {
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: 'from:no-reply@us.greenhouse-mail.io newer_than:1h subject:"Security code"',
          maxResults: 5,
        });

        if (res.data.messages?.length > 0) {
          for (const msg of res.data.messages) {
            const full = await gmail.users.messages.get({
              userId: 'me',
              id: msg.id,
              format: 'full',
            });

            // Only process emails from the last 30 minutes
            const internalDate = parseInt(full.data.internalDate || '0', 10);
            if (internalDate < Date.now() - 30 * 60 * 1000) continue;

            // Check snippet first - the code is always visible there
            const snippet = full.data.snippet || '';
            const snippetMatch = snippet.match(/security code field on your application:\s*([A-Za-z0-9]{8})/i);
            if (snippetMatch) {
              log('  Security code found: ' + snippetMatch[1]);
              return snippetMatch[1];
            }

            // Fall back to decoded body
            const bodyData = full.data.payload?.body?.data
              || full.data.payload?.parts?.[0]?.body?.data
              || '';
            if (bodyData) {
              const bodyText = Buffer.from(bodyData, 'base64').toString();
              const bodyMatch = bodyText.match(/security code field on your application:\s*([A-Za-z0-9]{8})/i);
              if (bodyMatch) {
                log('  Security code found: ' + bodyMatch[1]);
                return bodyMatch[1];
              }
            }
          }
        }
      } catch(e) {
        log('  Gmail poll error: ' + e.message);
      }

      await new Promise(r => setTimeout(r, 4000));
    }

    log('  Gmail polling timeout - no code after 90s');
  } catch(e) {
    log('  Gmail polling error: ' + e.message);
  }
  return null;
}

module.exports = { pollForSecurityCode };

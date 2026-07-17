// Google Sheets writer (no dependencies) — authenticates as a service account
// via JWT (RS256, node:crypto) and writes rows with the Sheets v4 API.
//
// Setup (one-time):
//   1. Google Cloud Console → IAM & Admin → Service Accounts → Create
//      (same project as the YouTube key is fine).
//   2. Create a JSON key for it, save as e.g. service-account.json (gitignored).
//   3. Enable "Google Sheets API" on the project.
//   4. Share the target spreadsheet with the service account's email
//      (Editor role) — like sharing with any collaborator.
//   5. .env: GOOGLE_SHEET_ID=<id from the sheet URL>
//           GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./service-account.json
//           GOOGLE_SHEET_TAB=Leads   (optional, default "Leads")

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fetchJson } from './util.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function getAccessToken(keyFile) {
  const sa = JSON.parse(await readFile(keyFile, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
  const data = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  return data.access_token;
}

// Replaces the tab's contents with header + rows (full-sync semantics, so the
// sheet always mirrors the CSV export exactly — dedupe and ordering included).
export async function syncToSheet({ sheetId, keyFile, tab = 'Leads', columns, rows }) {
  const token = await getAccessToken(keyFile);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;

  // Ensure the tab exists (ignore "already exists" errors).
  await fetchJson(`${base}:batchUpdate`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
  }, 0).catch(() => {});

  const range = encodeURIComponent(`${tab}!A1`);
  await fetchJson(`${base}/values/${encodeURIComponent(tab)}:clear`, { method: 'POST', headers: auth }, 1);
  const values = [columns, ...rows.map((r) => columns.map((c) => {
    const v = r[c];
    return v === null || v === undefined ? '' : v;
  }))];
  const res = await fetchJson(`${base}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ values }),
  }, 1);
  return res.updatedRows || values.length;
}

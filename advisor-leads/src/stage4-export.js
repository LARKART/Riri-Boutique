// Stage 4 — Computed fields, dedupe, QA, CSV export.
// Avg views (last 10), growth assessment (view-trend slope on recent uploads),
// dedupe on normalized channel URL + firm name.
// Output: data/advisor-leads.csv

import { writeFile } from 'node:fs/promises';
import { readJsonl, toCsv, dataPath, logRun } from './util.js';

const rows = await readJsonl('stage3-verified.jsonl');
console.log(`${rows.length} verified rows`);

function avgViews(videos) {
  const v = (videos || []).slice(0, 10).map((x) => x.viewCount).filter((n) => Number.isFinite(n));
  if (!v.length) return null;
  return Math.round(v.reduce((a, b) => a + b, 0) / v.length);
}

// Growth via least-squares slope of view counts over recent videos
// (oldest→newest). Flat/declining views despite steady uploads = target profile.
function growthAssessment(videos, uploadsLast60) {
  const pts = (videos || [])
    .filter((v) => v.publishedAt && Number.isFinite(v.viewCount))
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt))
    .map((v, i) => [i, v.viewCount]);
  if (pts.length < 4) return 'Unable to determine';
  const n = pts.length;
  const mx = pts.reduce((s, [x]) => s + x, 0) / n;
  const my = pts.reduce((s, [, y]) => s + y, 0) / n;
  const slope = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0)
              / pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const rel = my > 0 ? slope / my : 0; // slope relative to mean views
  if (rel > 0.08) return 'Growing';
  if (rel < -0.08) return 'Declining';
  return 'Flat';
}

function normalizeUrl(u) {
  return (u || '').toLowerCase().replace(/\/$/, '').replace(/\?.*$/, '');
}

// Dedupe on channel URL, then firm name
const seen = new Set();
const out = [];
for (const ch of rows) {
  const key1 = normalizeUrl(ch.channelUrl) || ch.channelId;
  const firm = ch.seedFirm?.name || (ch.iapdMatch?.kind === 'firm' ? ch.iapdMatch.name : null) || ch.title;
  const key2 = firm.toLowerCase().trim();
  if (seen.has(key1) || seen.has('firm:' + key2)) continue;
  seen.add(key1);
  seen.add('firm:' + key2);

  out.push({
    'Advisor Name': ch.advisorName || (ch.iapdMatch?.kind === 'individual' ? ch.iapdMatch.name : null),
    'Firm Name': firm,
    'YouTube Channel URL': ch.channelUrl,
    'Subscriber Count': ch.subscriberCount,
    'Total Videos': ch.totalVideos,
    'Most Recent Upload Date': ch.lastUploadDate,
    'Avg Views (Last 10 Videos)': avgViews(ch.recentVideos),
    'Growth Assessment': growthAssessment(ch.recentVideos, ch.uploadsLast60Days),
    'Firm Website': ch.firmWebsite,
    'Primary Contact Email': ch.email,
    'Phone Number': ch.phone,
    'City & State': ch.cityState,
    'Credentials': ch.credentials,
    'LinkedIn Profile': ch.linkedin,
    'needs_review': ch.needs_review,
  });
}

const columns = [
  'Advisor Name', 'Firm Name', 'YouTube Channel URL', 'Subscriber Count',
  'Total Videos', 'Most Recent Upload Date', 'Avg Views (Last 10 Videos)',
  'Growth Assessment', 'Firm Website', 'Primary Contact Email', 'Phone Number',
  'City & State', 'Credentials', 'LinkedIn Profile', 'needs_review',
];

await writeFile(dataPath('advisor-leads.csv'), toCsv(out, columns));

const clean = out.filter((r) => !r.needs_review);
const target = out.filter((r) => ['Flat', 'Declining'].includes(r['Growth Assessment']) && !r.needs_review);
console.log(`Exported ${out.length} deduped rows → ${dataPath('advisor-leads.csv')}`);
console.log(`  ${clean.length} fully verified (needs_review=false)`);
console.log(`  ${target.length} ideal prospects (verified + flat/declining growth)`);
await logRun('stage4-export', { exported: out.length, verified: clean.length, idealProspects: target.length, needsReview: out.length - clean.length });

// Optional: mirror the export into a Google Sheet (see src/sheets.js setup).
if (process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
  try {
    const { syncToSheet } = await import('./sheets.js');
    const updated = await syncToSheet({
      sheetId: process.env.GOOGLE_SHEET_ID,
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      tab: process.env.GOOGLE_SHEET_TAB || 'Leads',
      columns,
      rows: out,
    });
    console.log(`Synced ${updated} rows (incl. header) to Google Sheet ${process.env.GOOGLE_SHEET_ID}`);
  } catch (err) {
    console.error(`Google Sheets sync failed: ${err.message.slice(0, 200)} — CSV export is unaffected.`);
  }
} else {
  console.log('Google Sheets sync skipped (set GOOGLE_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_KEY_FILE to enable).');
}
console.log('QA reminder: spot-check a random 5% sample against adviserinfo.sec.gov before delivery.');

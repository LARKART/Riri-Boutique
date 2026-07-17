// Stage 0 — Seed list from SEC IAPD bulk data (free, no key).
// Downloads the public compilation feed of SEC + state-registered investment
// advisers and filters to advisory/wealth-management/financial-planning firms.
// Output: data/stage0-firms.jsonl (pre-verified US-registered firms).
//
// Feeds (XML, refreshed roughly weekly; date-stamped filenames):
//   https://reports.adviserinfo.sec.gov/reports/CompilationReports/IA_FIRM_SEC_Feed_<MM>_<DD>_<YYYY>.xml.gz
//   https://reports.adviserinfo.sec.gov/reports/CompilationReports/IA_FIRM_STATE_Feed_<MM>_<DD>_<YYYY>.xml.gz
// This script probes the last ~14 days of filenames to find the current one.
// You can also download manually and pass a local file:
//   node src/stage0-seed.js <file.xml|.xml.gz|.csv>
// Supported local formats:
//   - XML compilation feed from https://adviserinfo.sec.gov/compilation
//   - CSV from SEC "Information About Registered Investment Advisers and
//     Exempt Reporting Advisers" monthly data (sec.gov/foia-services/
//     frequently-requested-documents/form-adv-data)

import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { writeJsonl, dataPath, sleep } from './util.js';

const BASE = 'https://reports.adviserinfo.sec.gov/reports/CompilationReports';
const FEEDS = ['IA_FIRM_SEC_Feed', 'IA_FIRM_STATE_Feed'];

// Firms whose name signals the target practice type.
const NAME_MATCH = /\b(wealth|financial|advisor|advisory|capital|planning|retirement|asset|invest|tax|fiduciary|cpa)\b/i;
const NAME_EXCLUDE = /\b(hedge|private equity|venture|bank|insurance company|trust company)\b/i;

async function fetchFeed(feed) {
  const now = new Date();
  for (let back = 0; back < 15; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const url = `${BASE}/${feed}_${mm}_${dd}_${d.getFullYear()}.xml.gz`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (res.ok) {
        console.log(`Downloading ${url}`);
        return Buffer.from(await res.arrayBuffer());
      }
    } catch { /* try next date */ }
    await sleep(200);
  }
  return null;
}

function parseFirms(xml) {
  const firms = [];
  // Each firm is one <Firm>...</Firm> element with attribute-style fields.
  const firmRe = /<Firm(?:s)?\b[^>]*>[\s\S]*?<\/Firm(?:s)?>|<Firm\b[^>]*\/>/g;
  const attr = (block, tag, name) => {
    const m = block.match(new RegExp(`<${tag}\\b[^>]*?\\b${name}="([^"]*)"`, 'i'));
    return m ? m[1].trim() : null;
  };
  for (const block of xml.match(firmRe) || []) {
    const name = attr(block, 'Info', 'BusNm') || attr(block, 'Info', 'LegalNm');
    if (!name) continue;
    const crd = attr(block, 'Info', 'FirmCrdNb');
    const city = attr(block, 'MainAddr', 'City');
    // State feed often has an empty MainAddr — fall back to Item3C/@StateCD.
    const state = attr(block, 'MainAddr', 'State') || attr(block, 'Item3C', 'StateCD');
    const country = attr(block, 'MainAddr', 'Cntry') || attr(block, 'Item3C', 'CntryNm');
    // SEC feed: <Rgstn St="APPROVED"/>; State feed: <StateRgstn><Rgltrs><Rgltr St="APPROVED"/>.
    const registrationStatus = attr(block, 'Rgstn', 'St') || attr(block, 'Rgltr', 'St');
    const webMatch = block.match(/<WebAddr>\s*([^<\s]+)\s*<\/WebAddr>/i);
    firms.push({ name, crd, city, state, country, registrationStatus, website: webMatch ? webMatch[1] : null });
  }
  return firms;
}

// --- CSV support (SEC monthly Form ADV data files) ---
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseFirmsCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const col = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iName = col('primary business name', 'business name', 'firm name');
  const iLegal = col('legal name');
  const iCrd = col('crd', 'organization crd');
  const iCity = col('main office city', 'city');
  const iState = col('main office state', 'state');
  const iCountry = col('main office country', 'country');
  const iWeb = col('website', 'web address');
  const iStatus = col('sec status', 'registration status', 'sec current registration status');
  if (iName < 0 && iLegal < 0) throw new Error(`Unrecognized CSV header: ${header.slice(0, 10).join(', ')}...`);
  return lines.slice(1).map((l) => {
    const f = parseCsvLine(l);
    const get = (i) => (i >= 0 && f[i] ? f[i].trim() : null);
    return {
      name: get(iName) || get(iLegal),
      crd: get(iCrd),
      city: get(iCity),
      state: get(iState),
      country: get(iCountry),
      website: get(iWeb),
      registrationStatus: get(iStatus),
    };
  }).filter((f) => f.name);
}

// Accepts one or more local files (.xml, .xml.gz, .csv) and merges them.
const localFiles = process.argv.slice(2);
let all = [];
const perFile = [];
if (localFiles.length) {
  for (const file of localFiles) {
    const buf = await readFile(file);
    const text = file.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    const firms = (file.replace(/\.gz$/, '').endsWith('.csv') || !text.trimStart().startsWith('<'))
      ? parseFirmsCsv(text)
      : parseFirms(text);
    const src = file.split('/').pop();
    firms.forEach((f) => { f._src = src; });
    perFile.push({ file: src, parsed: firms.length });
    all.push(...firms);
  }
} else {
  let xml;
  const parts = [];
  for (const feed of FEEDS) {
    const buf = await fetchFeed(feed);
    if (buf) parts.push(gunzipSync(buf).toString('utf8'));
    else console.error(`Could not locate a recent ${feed} file — download manually from https://adviserinfo.sec.gov/compilation`);
  }
  if (!parts.length) {
    console.error('No feed downloaded. If this environment blocks sec.gov, run locally or pass a downloaded file path.');
    process.exit(1);
  }
  xml = parts.join('\n');
  all = parseFirms(xml);
  perFile.push({ file: 'downloaded feeds', parsed: all.length });
}

const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const passes = (f) =>
  f.state && US_STATES.has(f.state)
  && (!f.country || /United States|USA/i.test(f.country))
  && (!f.registrationStatus || f.registrationStatus.toUpperCase() === 'APPROVED')
  && NAME_MATCH.test(f.name)
  && !NAME_EXCLUDE.test(f.name);
const filtered = all.filter(passes);

// Dedupe on CRD (or name+state)
const seen = new Set();
const unique = filtered.filter((f) => {
  const k = f.crd || `${f.name.toLowerCase()}|${f.state}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

await writeJsonl('stage0-firms.jsonl', unique.map((f) => ({
  advisor_name: null, // firm-level feed; individual names come later via enrichment
  firm_name: f.name,
  crd: f.crd,
  city: f.city,
  state: f.state,
  website: f.website,
  registration_status: f.registrationStatus || 'registered (per IAPD compilation)',
  source: 'SEC IAPD compilation',
  // legacy alias kept for stage1-match compatibility
  name: f.name,
})));
for (const pf of perFile) {
  const passed = all.filter((f) => f._src === pf.file && passes(f)).length;
  console.log(`  ${pf.file}: ${pf.parsed} firms parsed, ${passed} passed filter`);
}
console.log(`Parsed ${all.length} firms total → ${filtered.length} matching target profile → ${unique.length} unique`);
const noCity = unique.filter((f) => !f.city).length;
const noState = unique.filter((f) => !f.state).length;
console.log(`Location gaps in output: ${noCity} rows with null city, ${noState} with null state`);
console.log(`Stage 0 complete → ${dataPath('stage0-firms.jsonl')}`);

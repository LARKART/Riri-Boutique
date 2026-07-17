import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from './config.js';

export async function ensureDataDir() {
  await mkdir(config.dataDir, { recursive: true });
}

export function dataPath(name) {
  return config.dataDir + name;
}

export async function readJsonl(name) {
  const p = dataPath(name);
  if (!existsSync(p)) return [];
  const text = await readFile(p, 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function writeJsonl(name, rows) {
  await ensureDataDir();
  await writeFile(dataPath(name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export async function appendJsonl(name, row) {
  await ensureDataDir();
  await appendFile(dataPath(name), JSON.stringify(row) + '\n');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchJson(url, opts = {}, retries = 3) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`), { fatal: true });
      }
      return await res.json();
    } catch (err) {
      if (err.fatal || i >= retries) throw err;
      await sleep(2000 * 2 ** i);
    }
  }
}

export async function fetchText(url, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; LeadResearchBot/1.0)' },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') || '';
      if (!type.includes('html') && !type.includes('text')) return null;
      return await res.text();
    } catch {
      if (i >= retries) return null;
      await sleep(1500 * 2 ** i);
    }
  }
}

// CSV with proper quoting
export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(','));
  return lines.join('\n') + '\n';
}

// Append a per-stage run-log entry (Task 5: daily output logging).
export async function logRun(stage, metrics) {
  const { appendFile, mkdir } = await import('node:fs/promises');
  const dir = new URL('../logs/', import.meta.url).pathname;
  await mkdir(dir, { recursive: true });
  await appendFile(dir + 'runs.jsonl', JSON.stringify({ at: new Date().toISOString(), stage, ...metrics }) + '\n');
}

// Persistent monthly usage counters for Apollo/Hunter free tiers.
export async function bumpMonthlyUsage(service, n = 1) {
  const { readFile, writeFile } = await import('node:fs/promises');
  await ensureDataDir();
  const p = dataPath('enrichment-usage.json');
  let usage = {};
  try { usage = JSON.parse(await readFile(p, 'utf8')); } catch { /* first run */ }
  const month = new Date().toISOString().slice(0, 7);
  usage[month] = usage[month] || {};
  usage[month][service] = (usage[month][service] || 0) + n;
  await writeFile(p, JSON.stringify(usage, null, 2));
  return usage[month][service];
}

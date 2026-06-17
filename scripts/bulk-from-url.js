/**
 * Bulk import (lifecycle Stage 13): scrape a collection URL and create ALL
 * products as DRAFT (publish OFF). Resilient — logs created IDs and an error
 * report for skipped products (spec §15). Per-color images + FX pricing applied.
 *
 *   node --env-file=.env scripts/bulk-from-url.js <url> [limit]
 */

'use strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { runPipelineFromUrl } from '../src/pipeline.js';
import { adminProductUrl, numericId } from '../src/shopify/execute.js';

const url = process.argv[2];
const limit = process.argv[3] ? Number(process.argv[3]) : undefined;
if (!url) { console.error('Usage: node --env-file=.env scripts/bulk-from-url.js <url> [limit]'); process.exit(2); }

console.log(`→ BULK import (DRAFT, publish OFF, trustImages ON)${limit ? `, limit ${limit}` : ', ALL'}: ${url}\n`);

const results = await runPipelineFromUrl(url, {
  ...(limit ? { limit } : {}),
  execute: true,
  status: 'DRAFT',
  publish: false,
  scrape: { actorInput: { startUrls: [{ url }], ...(limit ? { maxItems: limit } : {}) } },
  map: { trustImages: true },
});

const created = [];
const skipped = [];
for (const r of results) {
  if (r.execution?.product) {
    const p = r.execution.product;
    const link = adminProductUrl(r.execution.shop.myshopifyDomain, p.id);
    created.push({ title: r.draft.title, id: p.id, url: link, variants: r.execution.variants.length });
    console.log(`✅ ${r.draft.title}`);
    console.log(`   ${p.id}  | ${r.execution.variants.length} variants | ${link}`);
  } else {
    const title = r.draft?.title || r.raw?.title || '(unknown)';
    skipped.push({ title, error: r.buildError || r.execError || 'unknown' });
    console.log(`❌ ${title}\n   ${r.buildError || r.execError}`);
  }
}

mkdirSync('logs', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = `logs/bulk-${stamp}.json`;
writeFileSync(logPath, JSON.stringify({ createdAt: new Date().toISOString(), source: url, created, skipped }, null, 2));

console.log(`\n=== BULK SUMMARY ===`);
console.log(`created: ${created.length} | skipped: ${skipped.length} | total: ${results.length}`);
console.log(`📝 log: ${logPath}`);
if (created.length) {
  console.log(`↩️  rollback all created:`);
  console.log(`   ${created.map((c) => numericId(c.id)).join(' ')}`);
}

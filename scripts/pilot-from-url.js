/**
 * Pilot from URL (Stage 0 -> 10 -> 11): scrape, build, and create DRAFT
 * product(s) on the verified store. Publishing stays OFF (opt-in elsewhere).
 * Logs created IDs for rollback (spec §15).
 *
 *   node --env-file=.env scripts/pilot-from-url.js <url> [limit]
 */

'use strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { runPipelineFromUrl } from '../src/pipeline.js';
import { adminProductUrl, numericId } from '../src/shopify/execute.js';

const url = process.argv[2];
const limit = Number(process.argv[3] || 1);
if (!url) { console.error('Usage: node --env-file=.env scripts/pilot-from-url.js <url> [limit]'); process.exit(2); }

console.log(`→ Pilot from URL (DRAFT, publish OFF, trustImages ON, limit ${limit}): ${url}\n`);

const results = await runPipelineFromUrl(url, {
  limit,
  execute: true,
  status: 'DRAFT',
  publish: false,
  scrape: { actorInput: { startUrls: [{ url }], maxItems: limit } },
  map: { trustImages: true },
});

mkdirSync('logs', { recursive: true });
for (const r of results) {
  const { shop, product, variants, collection } = r.execution;
  const link = adminProductUrl(shop.myshopifyDomain, product.id);
  console.log('✅ DRAFT created');
  console.log(`   Title      : ${r.draft.title}`);
  console.log(`   Product ID : ${product.id}`);
  console.log(`   Status     : ${product.status}`);
  console.log(`   Admin link : ${link}`);
  console.log(`   Variants   : ${variants.length}`);
  console.log(`   Collection : ${collection.title} (${collection.id})${collection.created ? ' [created]' : ' [existing]'}`);
  const media = product.media?.nodes || [];
  console.log(`   Media      : ${media.length ? media.map((m) => m.status).join(', ') : '(none)'}`);
  if (r.draft.qa.warnings.length) {
    console.log('   QA notes   :');
    for (const w of r.draft.qa.warnings) console.log(`     - ${w}`);
  }
  const logPath = `logs/pilot-${numericId(product.id)}.json`;
  writeFileSync(logPath, JSON.stringify({
    createdAt: new Date().toISOString(), source: url,
    productId: product.id, status: product.status, adminUrl: link,
    collectionId: collection.id, variantIds: variants.map((v) => ({ sku: v.sku, id: v.id })),
  }, null, 2));
  console.log(`   📝 Rollback: node --env-file=.env scripts/rollback.js ${product.id}\n`);
}

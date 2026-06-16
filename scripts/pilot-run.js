/**
 * Pilot execution (lifecycle Stage 12 + 10): build ONE product end-to-end and
 * create it as a DRAFT on the verified store. Logs created IDs for rollback
 * (spec 15). Real content generation (Claude) + real Shopify write.
 *
 *   node --env-file=.env scripts/pilot-run.js [path/to/input.json]
 */

'use strict';

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { buildProductDraft } from '../src/pipeline.js';
import { executeProductSet, adminProductUrl, numericId } from '../src/shopify/execute.js';

const inputPath = process.argv[2] || 'examples/serane.json';
const input = JSON.parse(readFileSync(inputPath, 'utf8'));

console.log(`→ Building draft from ${inputPath} (Claude content + transforms)...`);
const draft = await buildProductDraft(input); // real generateContent + taxonomy
console.log(`  title: ${draft.title}`);
console.log(`  variants: ${draft.variants.length} | media: ${draft.media.length} | category: ${draft.category.id}`);
if (draft.qa.warnings.length) {
  console.log('  ⚠️  warnings:');
  for (const w of draft.qa.warnings) console.log(`     - ${w}`);
}

console.log('\n→ Stage 3 identity guard + Stage 10 productSet (DRAFT)...');
const { shop, product, variants } = await executeProductSet(draft, { status: 'DRAFT' });

const url = adminProductUrl(shop.myshopifyDomain, product.id);
console.log('\n✅ DRAFT product created');
console.log(`   Store        : ${shop.name} (${shop.myshopifyDomain})`);
console.log(`   Product ID   : ${product.id}`);
console.log(`   Numeric ID   : ${numericId(product.id)}`);
console.log(`   Status       : ${product.status}`);
console.log(`   Handle       : ${product.handle}`);
console.log(`   Admin link   : ${url}`);
console.log(`   Variants     : ${variants.length}`);
for (const v of variants) console.log(`     - ${v.sku}  ${v.title}  (${v.id})`);
const media = product.media?.nodes || [];
console.log(`   Media        : ${media.length ? media.map((m) => m.status).join(', ') : '(none)'}`);

// Stage 15 — log created IDs for rollback.
mkdirSync('logs', { recursive: true });
const logPath = `logs/pilot-${numericId(product.id)}.json`;
writeFileSync(logPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  input: inputPath,
  shop: { name: shop.name, myshopifyDomain: shop.myshopifyDomain },
  productId: product.id,
  status: product.status,
  handle: product.handle,
  adminUrl: url,
  variantIds: variants.map((v) => ({ sku: v.sku, id: v.id })),
}, null, 2));
console.log(`\n   📝 Rollback log: ${logPath}`);
console.log(`   ↩️  To delete:   node --env-file=.env scripts/rollback.js ${product.id}`);

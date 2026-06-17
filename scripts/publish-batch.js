/**
 * Publish a batch of products to the Online Store and make them live.
 * Live = status ACTIVE *and* published to the Online Store publication; a DRAFT
 * product added to a publication is still not visible to shoppers.
 *
 *   node --env-file=.env scripts/publish-batch.js <bulk-log.json>
 *
 * Reads created product IDs from a bulk log, activates each, and publishes to
 * the Online Store channel (Google intentionally excluded). Runs behind the
 * store-identity guard.
 */

'use strict';

import { readFileSync } from 'node:fs';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { assertStoreIdentity } from '../src/shopify/identityGuard.js';
import { getTargetPublications, publishProduct } from '../src/shopify/publish.js';

const logPath = process.argv[2];
if (!logPath) { console.error('Usage: node --env-file=.env scripts/publish-batch.js <bulk-log.json>'); process.exit(2); }
const ids = JSON.parse(readFileSync(logPath, 'utf8')).created.map((c) => c.id);

const PRODUCT_ACTIVATE = `
mutation Activate($input: ProductInput!) {
  productUpdate(input: $input) { product { id status } userErrors { field message } }
}`.trim();

const shop = await assertStoreIdentity(); // Stage 3 guard (once)
// Online Store ONLY — Google is intentionally excluded per client decision.
const { matched, all } = await getTargetPublications(['online store'], { skipGuard: true });
if (!matched.length) throw new Error(`Online Store publication not found among: ${all.map((p) => p.name).join(', ')}`);
const onlineStore = matched[0];

console.log(`→ Publishing ${ids.length} products to "${onlineStore.name}" on ${shop.myshopifyDomain} (status -> ACTIVE)\n`);

let ok = 0; const failed = [];
for (const id of ids) {
  try {
    const u = await shopifyGraphQL(PRODUCT_ACTIVATE, { input: { id, status: 'ACTIVE' } });
    if (u.productUpdate.userErrors.length) throw new Error(JSON.stringify(u.productUpdate.userErrors));
    await publishProduct(id, [onlineStore.id], { skipGuard: true });
    ok++;
    console.log(`✅ live: ${id}`);
  } catch (e) {
    failed.push({ id, error: e.message });
    console.log(`❌ ${id}: ${e.message}`);
  }
}

console.log(`\n=== PUBLISH SUMMARY ===`);
console.log(`live (ACTIVE + Online Store): ${ok} | failed: ${failed.length} | total: ${ids.length}`);

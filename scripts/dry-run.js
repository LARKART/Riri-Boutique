/**
 * Dry-run validation (lifecycle Stage 9).
 *
 * Builds the full productSet operation from a ProductDraft and runs PRE-FLIGHT
 * checks WITHOUT writing/publishing anything:
 *   1. Assemble the canonical draft (offline; content + taxonomy injected).
 *   2. Build the productSet query + variables and print the raw payload.
 *   3. Local structural QA (spec 14.5 subset) on the payload.
 *   4. Optional LIVE read-only schema check: if Shopify creds are present, run an
 *      introspection query (no mutation) to confirm productSet exists on the
 *      connected store's API. Falls back gracefully without creds.
 *
 * NOTE: Shopify's productSet has no native dryRun; the safe pre-flight is static
 * schema validation (done separately via the Shopify dev validation tool) plus
 * this read-only introspection. The mutation is never executed here.
 *
 *   node scripts/dry-run.js            (offline payload + local QA)
 *   node --env-file=.env scripts/dry-run.js   (also runs the live read-only check)
 */

'use strict';

import { readFileSync } from 'node:fs';
import { buildProductDraft } from '../src/pipeline.js';
import { buildProductSetOperation } from '../src/shopify/payload-builder.js';

const input = JSON.parse(readFileSync('examples/serane.json', 'utf8'));

// Offline stand-ins so the structure can be reviewed without network/API keys.
const fakeGenerate = async () => ({
  name: 'Serane',
  descriptionHtml:
    '<p>An elegant one-shoulder satin maxi for your next special occasion.</p>' +
    '<h3>Why you\'ll love it</h3><ul><li>Flattering one-shoulder neckline</li>' +
    '<li>Fluid satin drape</li></ul>',
  seo: {
    title: "Women's One Shoulder Wedding Guest Maxi Dress",
    description: 'Elegant one-shoulder satin maxi dress, perfect for weddings and formal events.',
  },
});
const fakeGql = async () => ({ taxonomy: { categories: { nodes: [] } } });

const draft = await buildProductDraft(input, { generate: fakeGenerate, gql: fakeGql });
const op = buildProductSetOperation(draft, { status: 'DRAFT' });

console.log('=== Stage 8: productSet operation (raw payload) ===\n');
console.log('# Mutation');
console.log(op.query);
console.log('\n# Variables');
console.log(JSON.stringify(op.variables, null, 2));

// --- Local structural QA (spec 14.5 subset) ---
console.log('\n=== Stage 9: local pre-flight QA ===');
const i = op.variables.input;
const checks = [];
const add = (label, ok) => checks.push({ label, ok });

add('title present', !!i.title);
add('descriptionHtml present', !!i.descriptionHtml);
add('category set', !!i.category);
add('exactly 2 product options (Color, Size)', i.productOptions?.length === 2);
add('every variant has optionValues + sku', i.variants.every((v) => v.optionValues?.length === 2 && v.sku));
add('every selling price ends in .95', i.variants.every((v) => v.price.endsWith('.95')));
add('every compare-at ends in .00', i.variants.every((v) => v.compareAtPrice.endsWith('.00')));
add('compare-at > price', i.variants.every((v) => Number(v.compareAtPrice) > Number(v.price)));
add('all SKUs unique', new Set(i.variants.map((v) => v.sku)).size === i.variants.length);
add('inventory tracking OFF on all variants', i.variants.every((v) => v.inventoryItem?.tracked === false));
add('feed metafields present', (i.metafields || []).length >= 4);
const fileSrcs = new Set((i.files || []).map((f) => f.originalSource));
add('every variant image is also a product file', i.variants.every((v) => !v.file || fileSrcs.has(v.file.originalSource)));

let failed = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? '✅' : '❌'} ${c.label}`);
  if (!c.ok) failed++;
}

if (draft.qa.warnings.length) {
  console.log('\n  ⚠️  draft warnings:');
  for (const w of draft.qa.warnings) console.log(`     - ${w}`);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} local pre-flight: ${checks.length - failed}/${checks.length} passed`);

// --- Optional live read-only schema check (no mutation) ---
if (process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN) {
  console.log('\n=== Stage 9: live read-only schema check ===');
  try {
    const { shopifyGraphQL } = await import('../src/shopify/client.js');
    const data = await shopifyGraphQL(
      `query { mutationType: __type(name: "ProductSetInput") { name kind } }`
    );
    const t = data?.mutationType;
    console.log(t?.name === 'ProductSetInput'
      ? `  ✅ live API confirms ProductSetInput exists (${t.kind})`
      : `  ❌ ProductSetInput not found on connected store`);
  } catch (err) {
    console.log(`  ⚠️  live check skipped: ${err.message}`);
  }
} else {
  console.log('\n(ℹ️  set SHOPIFY_* env vars to also run the live read-only schema check)');
}

process.exit(failed === 0 ? 0 : 1);

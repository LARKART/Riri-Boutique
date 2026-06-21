/**
 * Backfill a collection's occasion keyword into existing product titles + SEO
 * titles, in place. Derives the keyword from the collection name
 * ("Summer Dresses" -> "Summer") and inserts it before the length token, keeping
 * everything else (variants, images, prices, handle) untouched.
 *
 * Dry-run by default (prints samples); pass --apply to write.
 *
 *   node --env-file=.env scripts/backfill-collection-keyword.js --collection "Summer Dresses" [--samples 5] [--apply]
 */

'use strict';

import { shopifyGraphQL } from '../src/shopify/client.js';
import { collectionKeyword, insertKeywordBeforeLength, titleHasKeyword } from '../src/transform/occasion.js';
import { assertStoreIdentity } from '../src/shopify/identityGuard.js';

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const collectionName = arg('--collection');
const sampleN = arg('--samples') ? Number(arg('--samples')) : 5;
const apply = process.argv.includes('--apply');
if (!collectionName) { console.error('Usage: --collection "Name" [--samples N] [--apply]'); process.exit(2); }

const keyword = collectionKeyword(collectionName);
if (!keyword) { console.error(`Collection "${collectionName}" yields no keyword; nothing to inject.`); process.exit(2); }
console.log(`Collection: "${collectionName}" -> keyword "${keyword}" | mode: ${apply ? 'APPLY (writes)' : 'DRY-RUN'}\n`);

// Fetch all products in the collection with their title + SEO.
const QUERY = `query($q:String!,$after:String){
  collections(first:1, query:$q){ nodes{ id title
    products(first:100, after:$after){ pageInfo{hasNextPage endCursor}
      nodes{ id title seo{ title description } } } } } }`;
const products = [];
let after = null; let found = false;
do {
  const d = await shopifyGraphQL(QUERY, { q: `title:"${collectionName}"`, after });
  const coll = d.collections.nodes[0];
  if (!coll) break;
  found = true;
  products.push(...coll.products.nodes);
  after = coll.products.pageInfo.hasNextPage ? coll.products.pageInfo.endCursor : null;
} while (after);
if (!found) { console.error(`Collection "${collectionName}" not found.`); process.exit(1); }

// Compute changes.
const changes = [];
for (const p of products) {
  const newTitle = insertKeywordBeforeLength(p.title, keyword);
  const oldSeoTitle = p.seo?.title || '';
  const newSeoTitle = oldSeoTitle ? insertKeywordBeforeLength(oldSeoTitle, keyword) : oldSeoTitle;
  if (newTitle !== p.title || newSeoTitle !== oldSeoTitle) {
    changes.push({ id: p.id, oldTitle: p.title, newTitle, oldSeoTitle, newSeoTitle, seoDescription: p.seo?.description || null });
  }
}
const already = products.length - changes.length;
console.log(`Products: ${products.length} | need update: ${changes.length} | already have "${keyword}": ${already}\n`);

console.log(`— ${Math.min(sampleN, changes.length)} before/after sample(s) —`);
for (const c of changes.slice(0, sampleN)) {
  console.log(`  BEFORE title : ${c.oldTitle}`);
  console.log(`  AFTER  title : ${c.newTitle}`);
  console.log(`  BEFORE seo   : ${c.oldSeoTitle || '(none)'}`);
  console.log(`  AFTER  seo   : ${c.newSeoTitle || '(none)'}\n`);
}

if (!apply) {
  console.log('🔶 DRY-RUN: no writes. Re-run with --apply to update all titles + SEO titles in place.');
  process.exit(0);
}

// Apply behind the identity guard.
await assertStoreIdentity();
const MUT = `mutation($input:ProductInput!){ productUpdate(input:$input){ product{ id } userErrors{ field message } } }`;
let ok = 0; let fail = 0;
for (const c of changes) {
  try {
    const input = { id: c.id, title: c.newTitle };
    if (c.oldSeoTitle) input.seo = { title: c.newSeoTitle, description: c.seoDescription };
    const d = await shopifyGraphQL(MUT, { input });
    const ue = d.productUpdate.userErrors;
    if (ue.length) throw new Error(JSON.stringify(ue));
    ok++;
    console.log(`  ✅ ${c.newTitle}`);
  } catch (e) { fail++; console.log(`  ❌ ${c.oldTitle}: ${e.message}`); }
}
console.log(`\nUpdated ${ok}/${changes.length}${fail ? `, ${fail} failed` : ''}.`);
process.exitCode = fail ? 1 : 0;

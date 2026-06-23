/**
 * Store-wide rename of the variant option "Color" -> "Colour" (Canadian).
 * Resumable: only products whose option is still "Color" are updated. Values and
 * SKUs are untouched. Reports before/after counts; product count must stay equal.
 *   node --env-file=.env scripts/rename-color-option.js [--apply]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';

const APPLY = process.argv.includes('--apply');
const M = `mutation($pid:ID!,$opt:OptionUpdateInput!){ productOptionUpdate(productId:$pid, option:$opt){ userErrors{field message} } }`;

let after = null, scanned = 0, toRename = [], already = 0;
do {
  const d = await shopifyGraphQL(`query($a:String){ products(first:100,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id options(first:6){ id name } } } }`, { a: after });
  for (const p of d.products.nodes) {
    scanned++;
    const co = p.options.find((o) => o.name === 'Color');
    if (co) toRename.push({ id: p.id, optId: co.id });
    else if (p.options.some((o) => o.name === 'Colour')) already++;
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);

const before = await shopifyGraphQL(`query{ productsCount{count} }`, {});
console.log(`Scanned ${scanned} | already "Colour": ${already} | to rename "Color"->"Colour": ${toRename.length}`);
console.log(`Store product count BEFORE: ${before.productsCount.count}`);

if (!APPLY) { console.log('\n🔶 DRY-RUN: no changes. Re-run with --apply.'); process.exit(0); }

let ok = 0, fail = 0, n = 0;
for (const t of toRename) {
  n++;
  try {
    const r = await shopifyGraphQL(M, { pid: t.id, opt: { id: t.optId, name: 'Colour' } });
    if (r.productOptionUpdate.userErrors.length) throw new Error(JSON.stringify(r.productOptionUpdate.userErrors));
    ok++;
  } catch (e) { fail++; console.log(`  ❌ ${t.id}: ${e.message}`); }
  if (n % 100 === 0) console.log(`  ...${n}/${toRename.length} (ok ${ok}, fail ${fail})`);
}
const afterC = await shopifyGraphQL(`query{ productsCount{count} }`, {});
console.log(`\nRenamed: ${ok} | failed: ${fail}`);
console.log(`Store product count AFTER: ${afterC.productsCount.count} (before ${before.productsCount.count})`);
console.log(afterC.productsCount.count === before.productsCount.count ? '✅ count unchanged' : '⚠️ COUNT CHANGED');

/**
 * Set the COLOUR option VALUE of the 60 print products to a real base colour
 * (assessed from each product photo), keeping the print only in
 * mm-google-shopping.pattern. Regenerates affected SKUs. Count stays 1391.
 *   node --env-file=.env scripts/fix-print-base-colours.js [--apply]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { colorCode } from '../src/normalize/colors.js';
import fs from 'node:fs';
const APPLY = process.argv.includes('--apply');
const rows = JSON.parse(fs.readFileSync('/tmp/claude-0/-home-user-Riri-Boutique/edb3f54d-d602-5236-bcb6-52d60d84d362/scratchpad/sixty.json', 'utf8'));
// base colour per index (montage order)
const BASE = ['Blue','White','Multicolour','White','Multicolour','Pink','Blue','White','White','White',
'Blue','Green','Multicolour','Black','Gold','Blue','Multicolour','Black','Pink','Multicolour',
'White','Multicolour','Multicolour','Blue','Blue','White','Multicolour','Blue','Pink','Yellow',
'White','White','White','White','Multicolour','Navy','Blue','Beige','Navy','Beige',
'Multicolour','Multicolour','Green','Green','Pink','Multicolour','Multicolour','Multicolour','White','Multicolour',
'Red','Multicolour','Navy','Grey','Multicolour','White','Multicolour','Grey','Multicolour','Brown'];
const OPTM = `mutation($p:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){ productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$v){ userErrors{field message} } }`;
const VUPD = `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$p,variants:$v){ userErrors{field message} } }`;
const Q = `query($id:ID!){ product(id:$id){ options(first:6){id name optionValues{id name}} variants(first:100){nodes{id sku selectedOptions{name value}}} } }`;
const before = await shopifyGraphQL(`query{productsCount{count}}`, {});
let ok = 0, fail = 0, collide = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]; let base = BASE[i];
  const d = await shopifyGraphQL(Q, { id: 'gid://shopify/Product/' + r.id });
  const co = d.product.options.find((o) => /colou?r/i.test(o.name));
  const val = co.optionValues.find((v) => v.name.toLowerCase() === r.bad.toLowerCase());
  if (!val) { console.log(`  skip (value gone) ${r.title}`); continue; }
  const others = co.optionValues.filter((v) => v.id !== val.id).map((v) => v.name.toLowerCase());
  if (others.includes(base.toLowerCase())) { if (!others.includes('multicolour')) { base = 'Multicolour'; collide++; } else { console.log(`  ⚠️ collision, leaving ${r.title} (${r.bad})`); continue; } }
  const cc = colorCode(base);
  const sku = d.product.variants.nodes.filter((v) => (v.selectedOptions.find((s) => /colou?r/i.test(s.name)) || {}).value === val.name).map((v) => { const a = v.sku.split('-'); if (a.length >= 4) a[2] = cc; return { id: v.id, inventoryItem: { sku: a.join('-') } }; });
  console.log(`  #${i} ${r.title.split('|')[0].trim()} | "${r.bad}" -> "${base}" (pattern=${r.patMf}) | ${sku.length} sku`);
  if (!APPLY) continue;
  try {
    let res = await shopifyGraphQL(OPTM, { p: 'gid://shopify/Product/' + r.id, o: { id: co.id }, v: [{ id: val.id, name: base }] });
    if (res.productOptionUpdate.userErrors.length) throw new Error(JSON.stringify(res.productOptionUpdate.userErrors));
    if (sku.length) { res = await shopifyGraphQL(VUPD, { p: 'gid://shopify/Product/' + r.id, v: sku }); if (res.productVariantsBulkUpdate.userErrors.length) throw new Error(JSON.stringify(res.productVariantsBulkUpdate.userErrors)); }
    ok++;
  } catch (e) { fail++; console.log(`    ❌ ${e.message}`); }
}
const afterC = await shopifyGraphQL(`query{productsCount{count}}`, {});
console.log(`\n— ${APPLY ? 'APPLIED' : 'DRY'} — fixed ${ok}, collide-fallback ${collide}, fail ${fail} | count ${before.productsCount.count}->${afterC.productsCount.count} ${before.productsCount.count === afterC.productsCount.count ? '✅' : '⚠️'}`);

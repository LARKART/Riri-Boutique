/**
 * Normalize US "Multicolor" -> CA "Multicolour" in colour option VALUES, and
 * merge any product that carries BOTH spellings (delete the duplicate "Multicolor"
 * variants + remove that option value, keeping "Multicolour"). colorCode is "MUL"
 * for both, so SKUs are unchanged by the rename; merge removes duplicate SKUs.
 *   node --env-file=.env scripts/fix-multicolour-spelling.js [--apply]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';

const APPLY = process.argv.includes('--apply');
const OPTM = `mutation($p:ID!,$o:OptionUpdateInput!,$u:[OptionValueUpdateInput!],$del:[ID!]){ productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$u,optionValuesToDelete:$del){ userErrors{field message} } }`;
const VDEL = `mutation($p:ID!,$ids:[ID!]!){ productVariantsBulkDelete(productId:$p,variantsIds:$ids){ userErrors{field message} } }`;

const before = await shopifyGraphQL(`query{productsCount{count}}`, {});
let after = null; let renamed = 0, merged = 0, fail = 0; const ex = [];
do {
  const d = await shopifyGraphQL(`query($a:String){ products(first:100,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title options(first:6){id name optionValues{id name}} variants(first:120){nodes{id sku selectedOptions{name value}}} } } }`, { a: after });
  for (const p of d.products.nodes) {
    const co = p.options.find((o) => /colou?r/i.test(o.name)); if (!co) continue;
    const us = co.optionValues.find((v) => /^multicolor$/i.test(v.name.trim()));
    if (!us) continue;
    const ca = co.optionValues.find((v) => /^multicolour$/i.test(v.name.trim()));
    if (ca) {
      // merge: delete the "Multicolor" variants + remove the value
      const delIds = p.variants.nodes.filter((v) => (v.selectedOptions.find((s) => /colou?r/i.test(s.name)) || {}).value === us.name).map((v) => v.id);
      ex.push(`MERGE ${p.title.split('|')[0].trim()} | delete ${delIds.length} "Multicolor" dup variant(s); keep "Multicolour"`);
      if (APPLY) {
        try {
          if (delIds.length) { const r = await shopifyGraphQL(VDEL, { p: p.id, ids: delIds }); if (r.productVariantsBulkDelete.userErrors.length) throw new Error('vdel: ' + JSON.stringify(r.productVariantsBulkDelete.userErrors)); }
          const r2 = await shopifyGraphQL(OPTM, { p: p.id, o: { id: co.id }, u: null, del: [us.id] }); if (r2.productOptionUpdate.userErrors.length) throw new Error('optdel: ' + JSON.stringify(r2.productOptionUpdate.userErrors));
          merged++;
        } catch (e) { fail++; console.log(`  ❌ ${p.title}: ${e.message}`); }
      } else merged++;
    } else {
      // rename
      ex.push(`RENAME ${p.title.split('|')[0].trim()} | "Multicolor" -> "Multicolour"`);
      if (APPLY) {
        try { const r = await shopifyGraphQL(OPTM, { p: p.id, o: { id: co.id }, u: [{ id: us.id, name: 'Multicolour' }], del: null }); if (r.productOptionUpdate.userErrors.length) throw new Error(JSON.stringify(r.productOptionUpdate.userErrors)); renamed++; }
        catch (e) { fail++; console.log(`  ❌ ${p.title}: ${e.message}`); }
      } else renamed++;
    }
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);
const afterC = await shopifyGraphQL(`query{productsCount{count}}`, {});
console.log(`— ${APPLY ? 'APPLIED' : 'DRY'} —`); ex.forEach((e) => console.log('  ' + e));
console.log(`\nrenamed: ${renamed} | merged: ${merged} | fail: ${fail} | count ${before.productsCount.count}->${afterC.productsCount.count} ${before.productsCount.count === afterC.productsCount.count ? '✅' : '⚠️'}`);

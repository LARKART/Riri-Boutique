/**
 * Apply the final colour-value fixes (feed-affecting):
 *  - 6 image-confirmed: rename "Default" -> real colour; prints also get
 *    mm-google-shopping.pattern + base color metafields.
 *  - Peggy: rename all compound colour values to base-colour-led forms.
 * Regenerates affected variant SKUs. Count stays 1391.
 *   node --env-file=.env scripts/apply-colour-fixes-final.js [--apply]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { colorCode } from '../src/normalize/colors.js';

const APPLY = process.argv.includes('--apply');
const FEED = 'mm-google-shopping';
const nameOf = (t) => (String(t || '').includes(' | ') ? t.split(' | ').pop().trim() : '');

const SIX = {
  luana: { set: 'Yellow' }, melantha: { set: 'Navy' }, hester: { set: 'Lilac' }, cressida: { set: 'Fuchsia' },
  giselle: { set: 'Geometric', pattern: 'Geometric', base: 'Multicolour' },
  jacqueline: { set: 'Striped', pattern: 'Striped', base: 'Grey' },
};
const PEGGY = {
  'geometric pink & grey': 'Pink Geometric', 'pink & black striped': 'Pink Striped', 'blue and green': 'Blue/Green',
  'black with pattern': 'Black Patterned', 'black with sleeve pattern': 'Black Print', 'white with sleeve design': 'White Print',
  'black with flower': 'Black Floral', 'blue with flower': 'Blue Floral',
};

const OPTM = `mutation($p:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){ productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$v){ userErrors{field message} } }`;
const VUPD = `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$p,variants:$v){ userErrors{field message} } }`;
const MFM = `mutation($mf:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ userErrors{field message} } }`;

function skuRegen(variants, oldName, newName) {
  const cc = colorCode(newName);
  return variants.filter((v) => (v.selectedOptions.find((s) => /colou?r/i.test(s.name)) || {}).value === oldName)
    .map((v) => { const p = String(v.sku || '').split('-'); if (p.length >= 4 && p[0] === 'RIRI') p[2] = cc; return { id: v.id, inventoryItem: { sku: p.join('-') } }; });
}

const before = await shopifyGraphQL(`query{productsCount{count}}`, {});
let after = null, sixDone = 0, peggyDone = 0, fail = 0;
do {
  const d = await shopifyGraphQL(`query($a:String){ products(first:50,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title options(first:6){id name optionValues{id name}} variants(first:100){nodes{id sku selectedOptions{name value}}} } } }`, { a: after });
  for (const p of d.products.nodes) {
    const nm = nameOf(p.title).toLowerCase();
    const co = p.options.find((o) => /colou?r/i.test(o.name));
    if (!co) continue;
    if (SIX[nm]) {
      const def = co.optionValues.find((v) => /^default$/i.test(v.name));
      if (!def) continue;
      const cfg = SIX[nm];
      const sku = skuRegen(p.variants.nodes, def.name, cfg.set);
      console.log(`  SIX ${p.title} | "Default" -> "${cfg.set}"${cfg.pattern ? ` [pattern=${cfg.pattern}, base=${cfg.base}]` : ''} | ${sku.length} sku(s)`);
      if (APPLY) {
        try {
          let r = await shopifyGraphQL(OPTM, { p: p.id, o: { id: co.id }, v: [{ id: def.id, name: cfg.set }] });
          if (r.productOptionUpdate.userErrors.length) throw new Error(JSON.stringify(r.productOptionUpdate.userErrors));
          if (sku.length) { r = await shopifyGraphQL(VUPD, { p: p.id, v: sku }); if (r.productVariantsBulkUpdate.userErrors.length) throw new Error(JSON.stringify(r.productVariantsBulkUpdate.userErrors)); }
          if (cfg.pattern) { r = await shopifyGraphQL(MFM, { mf: [{ ownerId: p.id, namespace: FEED, key: 'pattern', type: 'single_line_text_field', value: cfg.pattern }, { ownerId: p.id, namespace: FEED, key: 'color', type: 'single_line_text_field', value: cfg.base }] }); if (r.metafieldsSet.userErrors.length) throw new Error(JSON.stringify(r.metafieldsSet.userErrors)); }
          sixDone++;
        } catch (e) { fail++; console.log('    ❌ ' + e.message); }
      }
      continue;
    }
    const peggyVals = co.optionValues.filter((v) => PEGGY[v.name.toLowerCase()]);
    if (peggyVals.length >= 3) {
      const upd = peggyVals.map((v) => ({ id: v.id, name: PEGGY[v.name.toLowerCase()] }));
      let skuAll = [];
      for (const v of peggyVals) skuAll = skuAll.concat(skuRegen(p.variants.nodes, v.name, PEGGY[v.name.toLowerCase()]));
      console.log(`  PEGGY ${p.title} | ${peggyVals.map((v) => `"${v.name}"->"${PEGGY[v.name.toLowerCase()]}"`).join(', ')} | ${skuAll.length} sku(s)`);
      if (APPLY) {
        try {
          let r = await shopifyGraphQL(OPTM, { p: p.id, o: { id: co.id }, v: upd });
          if (r.productOptionUpdate.userErrors.length) throw new Error(JSON.stringify(r.productOptionUpdate.userErrors));
          if (skuAll.length) { r = await shopifyGraphQL(VUPD, { p: p.id, v: skuAll }); if (r.productVariantsBulkUpdate.userErrors.length) throw new Error(JSON.stringify(r.productVariantsBulkUpdate.userErrors)); }
          peggyDone++;
        } catch (e) { fail++; console.log('    ❌ ' + e.message); }
      }
    }
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);
const afterC = await shopifyGraphQL(`query{productsCount{count}}`, {});
console.log(`\n— ${APPLY ? 'APPLIED' : 'DRY'} — six:${sixDone} peggy:${peggyDone} fail:${fail} | count ${before.productsCount.count}->${afterC.productsCount.count} ${before.productsCount.count === afterC.productsCount.count ? '✅' : '⚠️'}`);

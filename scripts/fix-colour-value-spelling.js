/**
 * Canadian spelling for colour OPTION VALUES (feed-affecting). gray->grey and
 * color->colour inside colour values only. Renames the option value, regenerates
 * affected variant SKUs (colour segment only), and updates a pattern metafield
 * that referenced the old value (Colorblock->Colourblock). Nothing else changes.
 *
 *   node --env-file=.env scripts/fix-colour-value-spelling.js [--apply] [--sample N]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { colorCode } from '../src/normalize/colors.js';

const APPLY = process.argv.includes('--apply');
const SAMPLE = process.argv.includes('--sample') ? Number(process.argv[process.argv.indexOf('--sample') + 1]) : (APPLY ? Infinity : 5);
const FEED_NS = 'mm-google-shopping';

// US -> CA inside a colour value, capitalization-preserving.
function caVal(v) {
  return String(v)
    .replace(/Gray/g, 'Grey').replace(/gray/g, 'grey').replace(/GRAY/g, 'GREY')
    .replace(/Color/g, 'Colour').replace(/color/g, 'colour').replace(/COLOR/g, 'COLOUR');
}
const isPatternVal = (v) => /colou?rblock|floral|geometric|striped|patchwork|chevron|paisley|animal|polka|gingham|plaid|houndstooth|camo|abstract|tropical|tie.?dye/i.test(v);

const OPTM = `mutation($p:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){ productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$v){ userErrors{field message} } }`;
const VARM = `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$p,variants:$v){ userErrors{field message} } }`;
const MFM = `mutation($mf:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ userErrors{field message} } }`;

// find affected products
let after = null; const affected = [];
do {
  const d = await shopifyGraphQL(`query($a:String){ products(first:50,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title
    options(first:6){ id name optionValues{ id name } }
    metafields(first:40){ nodes{ id namespace key value } }
    variants(first:100){ nodes{ id sku selectedOptions{ name value } } } } } }`, { a: after });
  for (const p of d.products.nodes) {
    const co = (p.options || []).find((o) => /colou?r/i.test(o.name));
    if (!co) continue;
    const renames = co.optionValues.filter((ov) => caVal(ov.name) !== ov.name).map((ov) => ({ id: ov.id, oldName: ov.name, newName: caVal(ov.name) }));
    if (renames.length) affected.push({ id: p.id, title: p.title, optId: co.id, renames, variants: p.variants.nodes, metafields: p.metafields.nodes });
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);

console.log(`Affected products: ${affected.length}`);
const before = await shopifyGraphQL(`query{ productsCount{count} }`, {});

// --ids id,id,... restricts to specific products (pilot); else first SAMPLE.
const idsArg = process.argv.includes('--ids') ? process.argv[process.argv.indexOf('--ids') + 1].split(',') : null;
const pool = idsArg ? affected.filter((p) => idsArg.some((x) => p.id.endsWith(x))) : affected;
const slice = pool.slice(0, idsArg ? pool.length : SAMPLE);
let okV = 0, okS = 0, okM = 0, fail = 0; let shown = 0;
for (const p of slice) {
  // compute per-variant SKU changes for the renamed colours
  const renameByOld = new Map(p.renames.map((r) => [r.oldName, r.newName]));
  const skuUpdates = [];
  for (const v of p.variants) {
    const colourVal = (v.selectedOptions.find((s) => /colou?r/i.test(s.name)) || {}).value;
    if (!colourVal || !renameByOld.has(colourVal)) continue;
    const parts = String(v.sku || '').split('-'); // RIRI-NAME-COLOR-SIZE
    if (parts.length >= 4 && parts[0] === 'RIRI') {
      const newCode = colorCode(renameByOld.get(colourVal));
      if (parts[2] !== newCode) { const np = [...parts]; np[2] = newCode; skuUpdates.push({ id: v.id, oldSku: v.sku, newSku: np.join('-') }); }
    }
  }
  const patMf = p.metafields.find((m) => m.namespace === FEED_NS && m.key === 'pattern' && caVal(m.value) !== m.value);

  if (shown < 5) {
    shown++;
    console.log(`\n  ${p.title}`);
    for (const r of p.renames) console.log(`    value: "${r.oldName}" -> "${r.newName}"`);
    const ex = skuUpdates[0];
    console.log(`    sku  : ${ex ? `${ex.oldSku} -> ${ex.newSku}` : '(colour code unchanged, e.g. GRY/MUL/COL — SKU stays)'}`);
    if (patMf) console.log(`    metafield ${FEED_NS}.pattern: "${patMf.value}" -> "${caVal(patMf.value)}"`);
  }

  if (!APPLY) continue;
  try {
    const r1 = await shopifyGraphQL(OPTM, { p: p.id, o: { id: p.optId }, v: p.renames.map((r) => ({ id: r.id, name: r.newName })) });
    if (r1.productOptionUpdate.userErrors.length) throw new Error('option: ' + JSON.stringify(r1.productOptionUpdate.userErrors));
    okV++;
    if (skuUpdates.length) {
      const r2 = await shopifyGraphQL(VARM, { p: p.id, v: skuUpdates.map((s) => ({ id: s.id, inventoryItem: { sku: s.newSku } })) });
      if (r2.productVariantsBulkUpdate.userErrors.length) throw new Error('sku: ' + JSON.stringify(r2.productVariantsBulkUpdate.userErrors));
      okS += skuUpdates.length;
    }
    if (patMf) {
      const r3 = await shopifyGraphQL(MFM, { mf: [{ ownerId: p.id, namespace: FEED_NS, key: 'pattern', type: 'single_line_text_field', value: caVal(patMf.value) }] });
      if (r3.metafieldsSet.userErrors.length) throw new Error('mf: ' + JSON.stringify(r3.metafieldsSet.userErrors));
      okM++;
    }
  } catch (e) { fail++; console.log(`    ❌ ${p.title}: ${e.message}`); }
}

console.log(`\n— ${APPLY ? 'APPLIED' : 'DRY-RUN'} (${slice.length}/${affected.length} processed) —`);
if (APPLY) {
  const afterC = await shopifyGraphQL(`query{ productsCount{count} }`, {});
  console.log(`option-values renamed: ${okV} products | variant SKUs regenerated: ${okS} | pattern metafields updated: ${okM} | failed: ${fail}`);
  console.log(`product count: ${before.productsCount.count} -> ${afterC.productsCount.count} ${before.productsCount.count === afterC.productsCount.count ? '✅' : '⚠️ CHANGED'}`);
} else {
  console.log('🔶 DRY-RUN: no writes. Re-run with --apply.');
}

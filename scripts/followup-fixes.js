/**
 * Three follow-up fixes (feed-affecting where noted):
 *  1) Giselle: colour value "Geometric" -> "Multicolour" (keep pattern metafield).
 *  2) Peggy: remove product-level mm-google-shopping.pattern (mixed prints).
 *  3) Cressida: size range labels -> S/M/L/XL (from the parenthetical).
 * Regenerates affected SKUs. Count stays 1391.
 *   node --env-file=.env scripts/followup-fixes.js [--apply]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { colorCode } from '../src/normalize/colors.js';
import { sizeCode } from '../src/transform/sku.js';

const APPLY = process.argv.includes('--apply');
const nameOf = (t) => (String(t || '').includes(' | ') ? t.split(' | ').pop().trim() : '');
const OPTM = `mutation($p:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){ productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$v){ userErrors{field message} } }`;
const VUPD = `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$p,variants:$v){ userErrors{field message} } }`;
const MFD = `mutation($mf:[MetafieldIdentifierInput!]!){ metafieldsDelete(metafields:$mf){ deletedMetafields{key} userErrors{field message} } }`;

const before = await shopifyGraphQL(`query{productsCount{count}}`, {});
let after = null; const log = [];
do {
  const d = await shopifyGraphQL(`query($a:String){ products(first:50,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title options(first:6){id name optionValues{id name}} metafields(first:40){nodes{namespace key}} variants(first:100){nodes{id sku selectedOptions{name value}}} } } }`, { a: after });
  for (const p of d.products.nodes) {
    const nm = nameOf(p.title).toLowerCase();
    const co = p.options.find((o) => /colou?r/i.test(o.name));
    const so = p.options.find((o) => /size/i.test(o.name));

    // 1) GISELLE — Geometric (colour) -> Multicolour
    if (nm === 'giselle' && co) {
      const geo = co.optionValues.find((v) => /^geometric$/i.test(v.name));
      if (geo) {
        const sku = p.variants.nodes.filter((v) => (v.selectedOptions.find((s) => /colou?r/i.test(s.name)) || {}).value === geo.name).map((v) => { const a = v.sku.split('-'); if (a.length >= 4) a[2] = colorCode('Multicolour'); return { id: v.id, inventoryItem: { sku: a.join('-') } }; });
        log.push(`GISELLE colour "Geometric"->"Multicolour" (pattern metafield kept) | ${sku.length} sku(s)`);
        if (APPLY) { let r = await shopifyGraphQL(OPTM, { p: p.id, o: { id: co.id }, v: [{ id: geo.id, name: 'Multicolour' }] }); if (r.productOptionUpdate.userErrors.length) throw new Error('giselle opt: ' + JSON.stringify(r.productOptionUpdate.userErrors)); if (sku.length) { r = await shopifyGraphQL(VUPD, { p: p.id, v: sku }); if (r.productVariantsBulkUpdate.userErrors.length) throw new Error('giselle sku'); } }
      }
    }

    // 2) PEGGY — remove product-level pattern metafield
    if (nm === 'peggy' && p.metafields.nodes.some((m) => m.namespace === 'mm-google-shopping' && m.key === 'pattern')) {
      log.push('PEGGY remove product-level mm-google-shopping.pattern');
      if (APPLY) { const r = await shopifyGraphQL(MFD, { mf: [{ ownerId: p.id, namespace: 'mm-google-shopping', key: 'pattern' }] }); if (r.metafieldsDelete.userErrors.length) throw new Error('peggy mfd: ' + JSON.stringify(r.metafieldsDelete.userErrors)); }
    }

    // 3) CRESSIDA — size ranges -> S/M/L/XL
    if (nm === 'cressida' && so) {
      const ranges = so.optionValues.filter((v) => /\(([SMLX]+)\)/i.test(v.name));
      if (ranges.length) {
        const upd = ranges.map((v) => ({ id: v.id, name: v.name.match(/\(([SMLX]+)\)/i)[1].toUpperCase() }));
        const map = new Map(ranges.map((v) => [v.name, v.name.match(/\(([SMLX]+)\)/i)[1].toUpperCase()]));
        const sku = p.variants.nodes.map((v) => { const sv = (v.selectedOptions.find((s) => /size/i.test(s.name)) || {}).value; if (!map.has(sv)) return null; const a = v.sku.split('-'); if (a.length >= 4) a[3] = sizeCode(map.get(sv)); return { id: v.id, inventoryItem: { sku: a.join('-') } }; }).filter(Boolean);
        log.push(`CRESSIDA sizes ${ranges.map((v) => `"${v.name}"->"${map.get(v.name)}"`).join(', ')} | ${sku.length} sku(s)`);
        if (APPLY) { let r = await shopifyGraphQL(OPTM, { p: p.id, o: { id: so.id }, v: upd }); if (r.productOptionUpdate.userErrors.length) throw new Error('cressida opt: ' + JSON.stringify(r.productOptionUpdate.userErrors)); if (sku.length) { r = await shopifyGraphQL(VUPD, { p: p.id, v: sku }); if (r.productVariantsBulkUpdate.userErrors.length) throw new Error('cressida sku'); } }
      }
    }
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);
const afterC = await shopifyGraphQL(`query{productsCount{count}}`, {});
console.log(`— ${APPLY ? 'APPLIED' : 'DRY'} —`); log.forEach((l) => console.log('  ' + l));
console.log(`count ${before.productsCount.count}->${afterC.productsCount.count} ${before.productsCount.count === afterC.productsCount.count ? '✅' : '⚠️'}`);

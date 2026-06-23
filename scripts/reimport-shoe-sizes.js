/**
 * Re-import real footwear sizes for the 21 one-size shoes. Rebuilds Size from the
 * matched source product (normalized US/CA), WITHOUT re-importing media (renames
 * the existing "One Size" value to the first real size, adds the rest, regenerates
 * the existing variants' SKUs, and bulk-creates the remaining colour x size
 * variants reusing each colour's existing media). Prices/compare-at/images/colours
 * unchanged. No size fabrication — sizes come from source.
 *   node --env-file=.env scripts/reimport-shoe-sizes.js [--apply]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { productCode, sizeCode } from '../src/transform/sku.js';
import { colorCode } from '../src/normalize/colors.js';

const APPLY = process.argv.includes('--apply');
const ORIGIN = 'https://www.byjuniperlane.com';
const SHOE = ['sandals-women', 'mary-jane-shoes', 'sliders-women', 'heels-women', 'flats-women', 'sneakers-women'];
const tok = (u) => (String(u || '').split('?')[0].split('/').pop() || '').replace(/^\d+_/, '').toLowerCase();
const nameOf = (t) => (String(t || '').includes(' | ') ? t.split(' | ').pop().trim() : '');
const usSize = (s) => { const m = String(s).match(/(\d{1,2}(?:\.\d)?)/); return m ? m[1] : null; };

// source size index: token -> [sizes]
const sidx = new Map();
for (const slug of SHOE) for (let pg = 1; pg <= 6; pg++) {
  let b; try { b = await (await fetch(`${ORIGIN}/collections/${slug}/products.json?limit=250&page=${pg}`)).json(); } catch { break; }
  const ps = b.products || [];
  for (const p of ps) { const so = (p.options || []).find((o) => /size/i.test(o.name)); const sizes = so ? so.values : []; for (const im of p.images || []) { const t = tok(im.src); if (t && !sidx.has(t)) sidx.set(t, sizes); } }
  if (ps.length < 250) break;
}

// affected products
const ID = `query($a:String){ products(first:50,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title category{id}
  options(first:6){ id name optionValues{ id name } }
  media(first:10){ nodes{ ... on MediaImage{ image{url} } } }
  variants(first:100){ nodes{ id sku price compareAtPrice selectedOptions{name value} media(first:1){nodes{id}} } } } } }`;
let after = null; const targets = [];
do {
  const d = await shopifyGraphQL(ID, { a: after });
  for (const p of d.products.nodes) {
    if (!/aa-8/.test(p.category?.id || '')) continue;
    const so = p.options.find((o) => /size/i.test(o.name));
    if (!so || !so.optionValues.some((v) => /one size/i.test(v.name))) continue;
    targets.push(p);
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);
console.log(`Targets: ${targets.length} | source size index: ${sidx.size} tokens`);

const OPTM = `mutation($p:ID!,$o:OptionUpdateInput!,$add:[OptionValueCreateInput!],$upd:[OptionValueUpdateInput!]){ productOptionUpdate(productId:$p,option:$o,optionValuesToAdd:$add,optionValuesToUpdate:$upd){ userErrors{field message} } }`;
const VUPD = `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$p,variants:$v){ userErrors{field message} } }`;
const VCREATE = `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkCreate(productId:$p,variants:$v){ userErrors{field message} productVariants{id} } }`;

const before = await shopifyGraphQL(`query{ productsCount{count} }`, {});
let okP = 0, fail = 0, addedVariants = 0; let shown = 0;
for (const p of targets) {
  const name = nameOf(p.title);
  const colourOpt = p.options.find((o) => /colou?r/i.test(o.name));
  const sizeOpt = p.options.find((o) => /size/i.test(o.name));
  const oneSizeVal = sizeOpt.optionValues.find((v) => /one size/i.test(v.name));
  const tokens = [...new Set(p.media.nodes.map((m) => tok(m.image?.url)).filter(Boolean))];
  const srcSizesRaw = tokens.map((t) => sidx.get(t)).find(Boolean) || [];
  const sizes = [...new Set(srcSizesRaw.map(usSize).filter(Boolean))].sort((a, b) => parseFloat(a) - parseFloat(b));
  if (sizes.length < 2) { console.log(`  SKIP (no source sizes) ${p.title}`); continue; }
  // colour -> { variantId, mediaId, price, cmp }
  const byColour = new Map();
  for (const v of p.variants.nodes) { const cv = (v.selectedOptions.find((s) => /colou?r/i.test(s.name)) || {}).value || 'Default'; byColour.set(cv, { id: v.id, mediaId: v.media.nodes[0]?.id || null, price: v.price, cmp: v.compareAtPrice }); }
  const firstSize = sizes[0]; const restSizes = sizes.slice(1);

  if (shown < 4) { shown++; console.log(`\n  ${p.title}\n     colours: [${[...byColour.keys()].join('|')}]  sizes -> [${sizes.join(',')}]  variants ${p.variants.nodes.length} -> ${byColour.size * sizes.length}`); console.log(`     sample SKU: RIRI-${productCode(name)}-${colorCode([...byColour.keys()][0])}-${sizeCode(firstSize)}`); }

  if (!APPLY) continue;
  try {
    // 1) Size option: rename One Size -> firstSize, add the rest.
    const r1 = await shopifyGraphQL(OPTM, { p: p.id, o: { id: sizeOpt.id }, add: restSizes.map((s) => ({ name: s })), upd: [{ id: oneSizeVal.id, name: firstSize }] });
    if (r1.productOptionUpdate.userErrors.length) throw new Error('opt: ' + JSON.stringify(r1.productOptionUpdate.userErrors));
    // 2) Existing variants now size=firstSize: regen SKU.
    const upd = [...byColour.entries()].map(([colour, info]) => ({ id: info.id, inventoryItem: { sku: `RIRI-${productCode(name)}-${colorCode(colour)}-${sizeCode(firstSize)}` } }));
    const r2 = await shopifyGraphQL(VUPD, { p: p.id, v: upd });
    if (r2.productVariantsBulkUpdate.userErrors.length) throw new Error('vupd: ' + JSON.stringify(r2.productVariantsBulkUpdate.userErrors));
    // 3) Create colour x restSizes.
    const creates = [];
    for (const [colour, info] of byColour) for (const s of restSizes) creates.push({ optionValues: [{ optionName: colourOpt.name, name: colour }, { optionName: sizeOpt.name, name: s }], price: info.price, compareAtPrice: info.cmp, inventoryItem: { sku: `RIRI-${productCode(name)}-${colorCode(colour)}-${sizeCode(s)}`, tracked: false }, inventoryPolicy: 'CONTINUE', ...(info.mediaId ? { mediaId: info.mediaId } : {}) });
    for (let i = 0; i < creates.length; i += 100) {
      const r3 = await shopifyGraphQL(VCREATE, { p: p.id, v: creates.slice(i, i + 100) });
      if (r3.productVariantsBulkCreate.userErrors.length) throw new Error('vcreate: ' + JSON.stringify(r3.productVariantsBulkCreate.userErrors));
      addedVariants += r3.productVariantsBulkCreate.productVariants.length;
    }
    okP++;
  } catch (e) { fail++; console.log(`  ❌ ${p.title}: ${e.message}`); }
}
const afterC = await shopifyGraphQL(`query{ productsCount{count} }`, {});
console.log(`\n— ${APPLY ? 'APPLIED' : 'DRY-RUN'} — products rebuilt: ${okP} | variants added: ${addedVariants} | failed: ${fail}`);
console.log(`product count: ${before.productsCount.count} -> ${afterC.productsCount.count} ${before.productsCount.count === afterC.productsCount.count ? '✅' : '⚠️ CHANGED'}`);

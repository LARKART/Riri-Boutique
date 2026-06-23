/**
 * Relabel "Default" colour on single-colourway dresses to the real dominant
 * colour when it can be read from the source title (never guessed). Renames the
 * Color option value and regenerates the variant SKU (…-DEF-… -> …-<code>-…).
 *
 *   node --env-file=.env scripts/relabel-default-colors.js [--apply]
 */

'use strict';

import { shopifyGraphQL } from '../src/shopify/client.js';
import { assertStoreIdentity } from '../src/shopify/identityGuard.js';
import { normalizeColorName, colorCode } from '../src/normalize/colors.js';
import { normalizePattern } from '../src/normalize/patterns.js';

const APPLY = process.argv.includes('--apply');
const ORIGIN = 'https://www.byjuniperlane.com';
const SLUGS = ['mini-dresses-women', 'midi-dresses-women', 'maxi-dresses-women', 'sleeveless-dresses',
  'short-sleeve-dresses', 'long-sleeve-dresses-women', 'beach-dresses-women', 'evening-dresses-women'];
const COLLS = ['Mini Dresses', 'Midi Dresses', 'Maxi Dresses', 'Sleeveless Dresses', 'Short Sleeve Dresses', 'Long Sleeve Dresses', 'Beach Dresses', 'Evening Dresses'];
const imageToken = (u) => (String(u || '').split('?')[0].split('/').pop() || '').replace(/^\d+_/, '').toLowerCase();

/** First real colour word in a title (1- or 2-grams), or null. Patterns are not colours. */
function detectColor(title) {
  const words = String(title || '').replace(/[|]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (const n of [2, 1]) {
      if (i + n > words.length) continue;
      const cand = words.slice(i, i + n).join(' ');
      const c = normalizeColorName(cand);
      if (c && !normalizePattern(cand)) return c;
    }
  }
  return null;
}

await assertStoreIdentity();

// 1) source image-token -> source title (across the 8 sub-collections).
const srcTitle = new Map();
for (const slug of SLUGS) {
  for (let page = 1; page <= 10; page++) {
    const b = await (await fetch(`${ORIGIN}/collections/${slug}/products.json?limit=250&page=${page}`)).json();
    const ps = b.products || [];
    for (const p of ps) for (const im of p.images || []) { const t = imageToken(im.src); if (t && !srcTitle.has(t)) srcTitle.set(t, p.title); }
    if (ps.length < 250) break;
  }
}

// 2) find Default-colour products across the 8 collections (unique).
const seen = new Set(); const defaults = [];
for (const coll of COLLS) {
  let after = null;
  do {
    const d = await shopifyGraphQL(`query($q:String!,$a:String){ collections(first:1,query:$q){ nodes{ products(first:100,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title
      options(first:5){ id name optionValues{ id name } }
      media(first:20){ nodes{ ... on MediaImage { image{url} } } }
      variants(first:100){ nodes{ id sku } } } } } } }`, { q: `title:"${coll}"`, a: after });
    const con = d.collections.nodes[0].products;
    for (const p of con.nodes) {
      if (seen.has(p.id)) continue;
      const co = (p.options || []).find((o) => /colou?r/i.test(o.name));
      const def = co?.optionValues?.find((v) => v.name.toLowerCase() === 'default');
      if (!def) continue;
      seen.add(p.id);
      const tokens = [...new Set(p.media.nodes.map((m) => imageToken(m.image?.url)).filter(Boolean))];
      defaults.push({ id: p.id, title: p.title, optionId: co.id, defaultValueId: def.id, variants: p.variants.nodes, tokens });
    }
    after = con.pageInfo.hasNextPage ? con.pageInfo.endCursor : null;
  } while (after);
}
console.log(`Default-colour dresses found: ${defaults.length} | mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

const OPT_MUT = `mutation($p:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){ productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$v){ userErrors{field message} } }`;
const VAR_MUT = `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$p,variants:$v){ userErrors{field message} } }`;

let relabeled = 0, left = 0, fail = 0;
for (const d of defaults) {
  const stitle = d.tokens.map((t) => srcTitle.get(t)).find(Boolean) || '';
  const color = detectColor(stitle) || detectColor(d.title);
  if (!color) { left++; console.log(`  – leave "Default": ${d.title}  (source: "${stitle || '?'}")`); continue; }
  console.log(`  ✎ ${color.padEnd(12)} <- ${d.title}  (source: "${stitle}")`);
  if (!APPLY) { relabeled++; continue; }
  try {
    const r1 = await shopifyGraphQL(OPT_MUT, { p: d.id, o: { id: d.optionId }, v: [{ id: d.defaultValueId, name: color }] });
    if (r1.productOptionUpdate.userErrors.length) throw new Error(JSON.stringify(r1.productOptionUpdate.userErrors));
    const code = colorCode(color);
    const vIn = d.variants.filter((v) => /-DEF(-|$)/i.test(v.sku || '')).map((v) => ({ id: v.id, inventoryItem: { sku: v.sku.replace(/-DEF(-|$)/i, `-${code}$1`) } }));
    if (vIn.length) { const r2 = await shopifyGraphQL(VAR_MUT, { p: d.id, v: vIn }); if (r2.productVariantsBulkUpdate.userErrors.length) throw new Error(JSON.stringify(r2.productVariantsBulkUpdate.userErrors)); }
    relabeled++;
  } catch (e) { fail++; console.log(`    ❌ ${e.message}`); }
}
console.log(`\n${APPLY ? 'Relabeled' : 'Would relabel'}: ${relabeled} | left as Default: ${left}${fail ? ` | failed: ${fail}` : ''}`);

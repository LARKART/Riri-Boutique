/**
 * Relabel remaining "Default" colour on print dresses to the print name from the
 * source title (option label + SKU only — never touches the product title; the
 * pattern-metafield logic is unchanged). Honest: a specific print name when the
 * source states one, "Multicolor" for a generic multi-colour print, else leave.
 *
 *   node --env-file=.env scripts/relabel-print-colors.js [--apply]
 */

'use strict';

import { shopifyGraphQL } from '../src/shopify/client.js';
import { assertStoreIdentity } from '../src/shopify/identityGuard.js';
import { colorCode } from '../src/normalize/colors.js';

const APPLY = process.argv.includes('--apply');
const ORIGIN = 'https://www.byjuniperlane.com';
const SLUGS = ['mini-dresses-women', 'midi-dresses-women', 'maxi-dresses-women', 'sleeveless-dresses',
  'short-sleeve-dresses', 'long-sleeve-dresses-women', 'beach-dresses-women', 'evening-dresses-women'];
const COLLS = ['Mini Dresses', 'Midi Dresses', 'Maxi Dresses', 'Sleeveless Dresses', 'Short Sleeve Dresses', 'Long Sleeve Dresses', 'Beach Dresses', 'Evening Dresses'];
const imageToken = (u) => (String(u || '').split('?')[0].split('/').pop() || '').replace(/^\d+_/, '').toLowerCase();

// Specific print names first; generic multi-colour print -> "Multicolor"; else null (leave Default).
const PRINTS = [
  [/\bditsy\s+floral\b/i, 'Floral'], [/\bfloral\b/i, 'Floral'], [/\bgeometric\b/i, 'Geometric'],
  [/\bcolou?r\s?block\b/i, 'Colorblock'], [/\bpatchwork\b/i, 'Patchwork'], [/\bchevron\b/i, 'Chevron'],
  [/\b(?:animal|leopard|tiger|zebra|snake|cheetah)\b/i, 'Animal Print'], [/\bpaisley\b/i, 'Paisley'],
  [/\bpolka\s*dots?\b|\bdots?\b/i, 'Polka Dot'], [/\bstrip(?:e|ed|es)\b/i, 'Striped'], [/\btie[-\s]?dye\b/i, 'Tie Dye'],
  [/\bgingham\b/i, 'Gingham'], [/\b(?:plaid|tartan)\b/i, 'Plaid'], [/\bhoundstooth\b/i, 'Houndstooth'],
  [/\bcamo(?:uflage)?\b/i, 'Camouflage'], [/\babstract\b/i, 'Abstract'], [/\btropical\b/i, 'Tropical'],
  [/\bwatercolou?r\b/i, 'Watercolor'], [/\bbotanical\b/i, 'Botanical'],
];
function detectPrint(title) {
  const t = String(title || '');
  for (const [re, lab] of PRINTS) if (re.test(t)) return lab;
  if (/\bmulti[-\s]?colou?r\b|\bprints?\b|\bprinted\b/i.test(t)) return 'Multicolor';
  return null;
}

await assertStoreIdentity();

// source image-token -> source title
const srcTitle = new Map();
for (const slug of SLUGS) {
  for (let page = 1; page <= 10; page++) {
    const b = await (await fetch(`${ORIGIN}/collections/${slug}/products.json?limit=250&page=${page}`)).json();
    const ps = b.products || [];
    for (const p of ps) for (const im of p.images || []) { const t = imageToken(im.src); if (t && !srcTitle.has(t)) srcTitle.set(t, p.title); }
    if (ps.length < 250) break;
  }
}

// find remaining Default-colour products
const seen = new Set(); const defaults = [];
for (const coll of COLLS) {
  let after = null;
  do {
    const d = await shopifyGraphQL(`query($q:String!,$a:String){ collections(first:1,query:$q){ nodes{ products(first:100,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title
      options(first:5){ id name optionValues{ id name } } media(first:20){ nodes{ ... on MediaImage { image{url} } } } variants(first:100){ nodes{ id sku } } } } } } }`, { q: `title:"${coll}"`, a: after });
    const con = d.collections.nodes[0].products;
    for (const p of con.nodes) {
      if (seen.has(p.id)) continue;
      const co = (p.options || []).find((o) => /colou?r/i.test(o.name));
      const def = co?.optionValues?.find((v) => v.name.toLowerCase() === 'default');
      if (!def) continue;
      seen.add(p.id);
      defaults.push({ id: p.id, title: p.title, optionId: co.id, defaultValueId: def.id, variants: p.variants.nodes, tokens: [...new Set(p.media.nodes.map((m) => imageToken(m.image?.url)).filter(Boolean))] });
    }
    after = con.pageInfo.hasNextPage ? con.pageInfo.endCursor : null;
  } while (after);
}
console.log(`Remaining Default-colour dresses: ${defaults.length} | mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

const OPT_MUT = `mutation($p:ID!,$o:OptionUpdateInput!,$v:[OptionValueUpdateInput!]){ productOptionUpdate(productId:$p,option:$o,optionValuesToUpdate:$v){ userErrors{field message} } }`;
const VAR_MUT = `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$p,variants:$v){ userErrors{field message} } }`;

const byLabel = {}; let left = 0, fail = 0;
for (const d of defaults) {
  const stitle = d.tokens.map((t) => srcTitle.get(t)).find(Boolean) || d.title;
  const label = detectPrint(stitle);
  if (!label) { left++; console.log(`  – leave Default: ${d.title} (src: "${stitle}")`); continue; }
  const code = colorCode(label);
  byLabel[label] = byLabel[label] || { n: 0, code };
  byLabel[label].n++;
  console.log(`  ✎ ${label} (${code}) <- ${d.title}`);
  if (!APPLY) continue;
  try {
    const r1 = await shopifyGraphQL(OPT_MUT, { p: d.id, o: { id: d.optionId }, v: [{ id: d.defaultValueId, name: label }] });
    if (r1.productOptionUpdate.userErrors.length) throw new Error(JSON.stringify(r1.productOptionUpdate.userErrors));
    const vIn = d.variants.filter((v) => /-DEF(-|$)/i.test(v.sku || '')).map((v) => ({ id: v.id, inventoryItem: { sku: v.sku.replace(/-DEF(-|$)/i, `-${code}$1`) } }));
    if (vIn.length) { const r2 = await shopifyGraphQL(VAR_MUT, { p: d.id, v: vIn }); if (r2.productVariantsBulkUpdate.userErrors.length) throw new Error(JSON.stringify(r2.productVariantsBulkUpdate.userErrors)); }
  } catch (e) { fail++; console.log(`    ❌ ${e.message}`); }
}
console.log('\n— summary —');
for (const [lab, v] of Object.entries(byLabel)) console.log(`  ${lab}: ${v.n}  (SKU -${v.code}-)`);
console.log(`  left as Default: ${left}${fail ? ` | failed: ${fail}` : ''}`);

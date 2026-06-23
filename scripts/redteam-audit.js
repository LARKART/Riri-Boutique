/**
 * RED-TEAM analysis (READ-ONLY): GMC/trust risk signals beyond our own rules.
 *   node --env-file=.env scripts/redteam-audit.js
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import fs from 'node:fs';

const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const CLAIMS = [
  ['Orthopedic', /\borthop(a)?edic\b/i], ['Arch Support', /\barch[-\s]?support\b/i],
  ['Silk', /\bsilk\b/i], ['Linen', /\blinen\b/i], ['Cotton', /\bcotton\b/i], ['Leather', /\bleather\b/i],
  ['Suede', /\bsuede\b/i], ['Cashmere', /\bcashmere\b/i], ['Wool', /\bwool\b/i], ['Satin', /\bsatin\b/i],
  ['Velvet', /\bvelvet\b/i], ['Denim', /\bdenim\b/i], ['Memory Foam', /\bmemory\s*foam\b/i],
  ['Waterproof', /\bwater[-\s]?proof\b/i], ['Hypoallergenic', /\bhypoallergenic\b/i], ['Cushioned', /\bcushion(ed)?\b/i],
];

let after = null, total = 0;
const discounts = []; const lowPrice = []; const cmpBad = []; const nonCharm = [];
const claimTitle = {}; const claimDesc = {}; CLAIMS.forEach(([l]) => { claimTitle[l] = 0; claimDesc[l] = 0; });
const oneSizeFoot = []; const defaultColour = []; const oddColour = [];
const descOpen = new Map(); const descFull = new Map(); const genericShoe = []; let withMaterialMf = 0;
const NAMEDCOLOR = /^(black|white|ivory|cream|beige|tan|brown|grey|gray|navy|blue|teal|green|olive|yellow|gold|orange|coral|red|burgundy|wine|pink|rose|purple|lavender|lilac|silver|charcoal|khaki|mauve|peach|mint|sage|nude|champagne|apricot|rust|mustard|emerald|turquoise|fuchsia|magenta|maroon|slate|stone|sand|taupe|aqua|lime|plum|berry|chocolate|camel|denim|indigo|cobalt|salmon|blush|bronze|copper|pewter|ecru|oatmeal|caramel|cognac|terracotta|multicolou?r|army green|light blue|dark blue|sky blue|hot pink|off white|dark green|grey blue|black grey|colou?rblock|floral|geometric|striped|patchwork|chevron|animal print|leopard|paisley|polka dot)/i;

do {
  let d; try { d = await shopifyGraphQL(`query($a:String){ products(first:6,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title descriptionHtml productType category{id fullName} options(first:6){name optionValues{name}} variants(first:50){nodes{price compareAtPrice}} } } }`, { a: after }); }
  catch (e) { await new Promise((r) => setTimeout(r, 1500)); continue; }
  for (const p of d.products.nodes) {
    total++;
    const title = p.title; const desc = strip(p.descriptionHtml);
    const prices = p.variants.nodes.map((v) => Number(v.price)).filter(Boolean);
    const cmps = p.variants.nodes.map((v) => Number(v.compareAtPrice)).filter(Boolean);
    const price = prices.length ? Math.min(...prices) : 0;
    const cmp = cmps.length ? Math.max(...cmps) : 0;
    if (price && cmp) { const disc = 1 - price / cmp; discounts.push(disc); if (disc >= 0.7) cmpBad.push({ title, price, cmp, disc: Math.round(disc * 100) }); }
    if (price && price < 12) lowPrice.push({ title, price });
    for (const v of p.variants.nodes) { if (Number(v.compareAtPrice) <= Number(v.price)) { cmpBad.push({ title, note: 'cmp<=price' }); break; } }
    if (price && !/\.95$/.test(price.toFixed(2))) nonCharm.push({ title, price });
    for (const [l, re] of CLAIMS) { if (re.test(title)) claimTitle[l]++; if (re.test(desc)) claimDesc[l]++; }
    const colOpt = (p.options || []).find((o) => /colou?r/i.test(o.name));
    const sizeOpt = (p.options || []).find((o) => /size/i.test(o.name));
    const colVals = (colOpt?.optionValues || []).map((v) => v.name);
    const sizeVals = (sizeOpt?.optionValues || []).map((v) => v.name);
    const isShoe = /aa-8/.test(p.category?.id || '');
    if (isShoe && sizeVals.some((s) => /one size/i.test(s))) oneSizeFoot.push({ title });
    if (isShoe && p.category?.id === 'gid://shopify/TaxonomyCategory/aa-8') genericShoe.push({ title });
    if (colVals.some((c) => /^default$/i.test(c))) defaultColour.push({ title });
    for (const c of colVals) if (c && !NAMEDCOLOR.test(c.trim()) && !/^default$/i.test(c)) oddColour.push({ title, value: c });
    const open = desc.slice(0, 50).toLowerCase();
    descOpen.set(open, (descOpen.get(open) || 0) + 1);
    const h = desc.slice(0, 400).toLowerCase(); descFull.set(h, (descFull.get(h) || 0) + 1);
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);

discounts.sort((a, b) => a - b);
const pct = (a) => a.length ? `${Math.round(a[Math.floor(a.length * 0.5)] * 100)}% med, ${Math.round(a[Math.floor(a.length * 0.9)] * 100)}% p90, ${Math.round(a[a.length - 1] * 100)}% max` : '-';
const dups = [...descFull.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
const openDups = [...descOpen.entries()].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
const oddAgg = {}; for (const o of oddColour) oddAgg[o.value] = (oddAgg[o.value] || 0) + 1;

console.log(`\n===== RED-TEAM SIGNALS (read-only) — ${total} products =====`);
console.log(`\nDISCOUNT DEPTH: ${pct(discounts)} | products >=70% off: ${cmpBad.length}`);
console.log(`  e.g. ${cmpBad.slice(0, 4).map((c) => `${c.title?.split('|')[1]?.trim()||c.title} $${c.price}/$${c.cmp} (${c.disc}%)`).join(' · ')}`);
console.log(`LOW PRICE (<$12): ${lowPrice.length}  ${lowPrice.slice(0, 5).map((l) => `$${l.price}`).join(', ')}`);
console.log(`NON-CHARM price: ${nonCharm.length}`);
console.log(`\nMATERIAL/MEDICAL CLAIMS (title / description):`);
for (const [l] of CLAIMS) if (claimTitle[l] || claimDesc[l]) console.log(`  ${l}: title ${claimTitle[l]} / desc ${claimDesc[l]}`);
console.log(`\nGENERIC/ODD VALUES:`);
console.log(`  "One Size" on footwear: ${oneSizeFoot.length}  e.g. ${oneSizeFoot.slice(0, 3).map((x) => x.title.split('|')[0].trim()).join(' · ')}`);
console.log(`  "Default" colour: ${defaultColour.length}`);
console.log(`  generic Shoes (aa-8) category: ${genericShoe.length}`);
console.log(`  non-standard colour values: ${Object.keys(oddAgg).length} distinct, ${oddColour.length} instances`);
console.log(`     top: ${Object.entries(oddAgg).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([v, n]) => `"${v}"×${n}`).join(', ')}`);
console.log(`\nDESCRIPTION DUPLICATION:`);
console.log(`  exact-ish dup (first 400 chars) groups: ${dups.length}  ${dups.slice(0, 3).map(([, n]) => `×${n}`).join(', ')}`);
console.log(`  shared opening (first 50 chars, >=5): ${openDups.length} templates`);
openDups.slice(0, 8).forEach(([o, n]) => console.log(`     ×${n}: "${o}..."`));
fs.writeFileSync('/tmp/claude-0/-home-user-Riri-Boutique/edb3f54d-d602-5236-bcb6-52d60d84d362/scratchpad/redteam.json', JSON.stringify({ total, cmpBad: cmpBad.slice(0, 50), oddAgg, oneSizeFoot, defaultColour, openDups: openDups.slice(0, 20) }, null, 0));

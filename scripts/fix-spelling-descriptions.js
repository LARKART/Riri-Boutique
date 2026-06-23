/**
 * Apply SAFE Canadian-spelling fixes in descriptionHtml ONLY (no titles, no
 * colour values, no SKUs). Whole-word, capitalization-preserving:
 *   cozy->cosy, jewelry->jewellery, favor*->favour*, accessoriz*->accessoris*
 *   node --env-file=.env scripts/fix-spelling-descriptions.js [--apply]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';

const APPLY = process.argv.includes('--apply');
const CONC = 5;

// Preserve the leading-letter case of the matched word.
const cap = (out, m) => (/[A-Z]/.test(m[0]) ? out[0].toUpperCase() + out.slice(1) : out);

const RULES = [
  ['cozy → cosy', /\bcoz(y|ier|iest)\b/g, (m, suf) => cap('cos' + suf, m)],
  ['jewelry → jewellery', /\bjewelr(y|ies)\b/g, (m, suf) => cap(suf === 'ies' ? 'jewelleries' : 'jewellery', m)],
  ['favorite/favor → favour', /\bfavor(?!u)([a-z]*)\b/g, (m, rest) => cap('favour' + rest, m)],
  ['accessorize → accessorise', /\baccessoriz(e|es|ed|ing|ation)\b/g, (m, suf) => cap('accessoris' + suf, m)],
];
const flagI = (re) => new RegExp(re.source, re.flags.includes('i') ? re.flags : re.flags + 'i');

const stats = {}; RULES.forEach(([l]) => stats[l] = { changed: 0, example: null });

async function mapPool(items, limit, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } })); }

// gather products + descriptions
let after = null; const prods = [];
do {
  const d = await shopifyGraphQL(`query($a:String){ products(first:25,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title descriptionHtml } } }`, { a: after });
  prods.push(...d.products.nodes);
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);
const before = await shopifyGraphQL(`query{ productsCount{count} }`, {});

const UPD = `mutation($input:ProductInput!){ productUpdate(input:$input){ product{id} userErrors{field message} } }`;
let updated = 0, fail = 0;
await mapPool(prods, CONC, async (p) => {
  let html = p.descriptionHtml || ''; let changedAny = false;
  for (const [label, re, fn] of RULES) {
    const rx = flagI(re);
    if (!rx.test(html)) continue;
    const orig = html;
    html = html.replace(flagI(re), (...args) => fn(...args));
    if (html !== orig) {
      changedAny = true; stats[label].changed++;
      if (!stats[label].example) {
        const om = orig.match(flagI(re));
        const oWord = om ? om[0] : '';
        const nWord = oWord.replace(new RegExp(re.source, 'i'), (...a) => fn(...a));
        stats[label].example = { title: p.title, oWord, nWord };
      }
    }
  }
  if (changedAny && APPLY) {
    try { const r = await shopifyGraphQL(UPD, { input: { id: p.id, descriptionHtml: html } }); if (r.productUpdate.userErrors.length) throw new Error(JSON.stringify(r.productUpdate.userErrors)); updated++; }
    catch (e) { fail++; console.log(`  ❌ ${p.title}: ${e.message}`); }
  } else if (changedAny) { updated++; }
});

const afterC = await shopifyGraphQL(`query{ productsCount{count} }`, {});
console.log(`\n— ${APPLY ? 'APPLIED' : 'DRY-RUN'} (description-only) —`);
for (const [l] of RULES) { const s = stats[l]; console.log(`  ${l}: ${s.changed} description(s)${s.example ? `  e.g. "${s.example.oWord}"→"${s.example.nWord}" in "${s.example.title}"` : ''}`); }
console.log(`\nDescriptions updated (distinct products): ${updated}${fail ? ` | failed: ${fail}` : ''}`);
console.log(`Store product count: ${before.productsCount.count} -> ${afterC.productsCount.count} ${before.productsCount.count === afterC.productsCount.count ? '✅' : '⚠️ CHANGED'}`);

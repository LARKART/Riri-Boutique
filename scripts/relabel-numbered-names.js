/**
 * Relabel numbered/synthetic product names with clean real names from the widened
 * vocabulary. Updates the name in ALL FOUR places, consistently, per product:
 *   1) title (part after " | "; descriptive core unchanged)
 *   2) every variant SKU (RIRI-<NEWCODE>-<COLOR>-<SIZE>)
 *   3) SEO (global.title_tag + global.description_tag)
 *   4) descriptionHtml (every occurrence of the old name token)
 *
 * Names are allocated sequentially (unique vs the whole store); writes run in a
 * small parallel pool. Each product is re-read and VERIFIED (old name absent
 * everywhere, new name present) before counting it done. Resumable: a re-run only
 * sees names that still end in a digit. Values/colours/sizes/images/metafields/
 * pricing are untouched.
 *
 *   node --env-file=.env scripts/relabel-numbered-names.js [--apply] [--limit N]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { makeNameAllocator } from '../src/content/names.js';
import { productCode } from '../src/transform/sku.js';

const APPLY = process.argv.includes('--apply');
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;
const CONC = 5;
const nameOf = (t) => (String(t || '').includes(' | ') ? t.split(' | ').pop().trim() : '');
const coreOf = (t) => String(t || '').split(' | ')[0].trim();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]{}\\]/g, '\\$&');
const swap = (text, oldN, newN) => String(text || '').replace(new RegExp(`\\b${esc(oldN)}\\b`, 'g'), newN);
async function mapPool(items, limit, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } })); }

// 1) Gather all products (light) for names, then heavy fields for the numbered ones.
let after = null; const all = [];
do {
  const d = await shopifyGraphQL(`query($a:String){ products(first:50,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title } } }`, { a: after });
  for (const p of d.products.nodes) all.push(p);
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);
const liveNames = all.map((p) => nameOf(p.title)).filter(Boolean);
const numbered = all.filter((p) => /\d$/.test(nameOf(p.title))).slice(0, LIMIT === Infinity ? undefined : LIMIT);
console.log(`Total products: ${all.length} | numbered names to relabel: ${numbered.length}`);

// 2) Allocate one clean real name per numbered product (sequential, unique vs whole store).
const alloc = makeNameAllocator(liveNames);
const plan = numbered.map((p) => ({ id: p.id, oldName: nameOf(p.title), newName: alloc.take() }));
const synthOrNumbered = plan.filter((x) => /\d/.test(x.newName));
console.log(`Allocated ${plan.length} new names | numbered/synthetic in allocation: ${synthOrNumbered.length}`);
if (synthOrNumbered.length) { console.log('⛔ allocation produced non-real names — aborting (expand vocab).'); process.exit(1); }

if (!APPLY) {
  console.log('\n— sample old -> new (DRY-RUN, no writes) —');
  for (const s of plan.slice(0, 5)) {
    const d = await shopifyGraphQL(`query($id:ID!){ product(id:$id){ title descriptionHtml seo{title} variants(first:3){nodes{sku}} } }`, { id: s.id });
    const p = d.product; const oc = productCode(s.oldName), nc = productCode(s.newName);
    console.log(`\n  OLD "${s.oldName}" -> NEW "${s.newName}"`);
    console.log(`   1 title : ${p.title}  ->  ${coreOf(p.title)} | ${s.newName}`);
    console.log(`   2 sku   : ${p.variants.nodes[0]?.sku}  ->  ${p.variants.nodes[0]?.sku?.replace(`RIRI-${oc}-`, `RIRI-${nc}-`)}`);
    console.log(`   3 seo   : ${p.seo?.title}  ->  ${swap(p.seo?.title, s.oldName, s.newName)}`);
    const descSnippet = (p.descriptionHtml || '').replace(/<[^>]+>/g, ' ').slice(0, 140);
    console.log(`   4 desc  : "...${descSnippet}..." (all "${s.oldName}" -> "${s.newName}")`);
  }
  console.log('\n🔶 DRY-RUN: no writes. Re-run with --apply.');
  process.exit(0);
}

// 3) Apply + verify, in a small parallel pool.
const UPD = `mutation($input:ProductInput!){ productUpdate(input:$input){ product{id} userErrors{field message} } }`;
const VAR = `mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$pid,variants:$v){ userErrors{field message} } }`;
const MF = `mutation($mf:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ userErrors{field message} } }`;
const READ = `query($id:ID!){ product(id:$id){ title descriptionHtml seo{title description} variants(first:100){nodes{id sku}} } }`;

let done = 0, fail = 0, n = 0; const failures = [];
await mapPool(plan, CONC, async (s) => {
  n++;
  try {
    const d = await shopifyGraphQL(READ, { id: s.id });
    const p = d.product;
    const oc = productCode(s.oldName), nc = productCode(s.newName);
    const newTitle = `${coreOf(p.title)} | ${s.newName}`;
    const newDesc = swap(p.descriptionHtml, s.oldName, s.newName);
    const newSeoTitle = swap(p.seo?.title || newTitle, s.oldName, s.newName) || newTitle;
    const newSeoDesc = swap(p.seo?.description || '', s.oldName, s.newName);
    const vIn = p.variants.nodes.map((v) => ({ id: v.id, inventoryItem: { sku: (v.sku || '').startsWith(`RIRI-${oc}-`) ? `RIRI-${nc}-${v.sku.slice(`RIRI-${oc}-`.length)}` : (v.sku || '').replace(new RegExp(`RIRI-${esc(oc)}-`), `RIRI-${nc}-`) } }));

    const r1 = await shopifyGraphQL(UPD, { input: { id: s.id, title: newTitle, descriptionHtml: newDesc } });
    if (r1.productUpdate.userErrors.length) throw new Error('productUpdate: ' + JSON.stringify(r1.productUpdate.userErrors));
    const r2 = await shopifyGraphQL(VAR, { pid: s.id, v: vIn });
    if (r2.productVariantsBulkUpdate.userErrors.length) throw new Error('variants: ' + JSON.stringify(r2.productVariantsBulkUpdate.userErrors));
    const mf = [{ ownerId: s.id, namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: newSeoTitle }];
    if (newSeoDesc) mf.push({ ownerId: s.id, namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: newSeoDesc });
    const r3 = await shopifyGraphQL(MF, { mf });
    if (r3.metafieldsSet.userErrors.length) throw new Error('metafields: ' + JSON.stringify(r3.metafieldsSet.userErrors));

    // VERIFY: old name absent everywhere, new name present.
    const v = (await shopifyGraphQL(READ, { id: s.id })).product;
    const hay = [v.title, v.descriptionHtml, v.seo?.title, v.seo?.description, ...v.variants.nodes.map((x) => x.sku)].join('  ');
    const oldRe = new RegExp(`\\b${esc(s.oldName)}\\b`);
    const oldCodeRe = new RegExp(`RIRI-${esc(oc)}-`);
    if (oldRe.test(hay) || oldCodeRe.test(hay)) throw new Error(`leftover old name/code after write`);
    if (!new RegExp(`\\b${esc(s.newName)}\\b`).test(v.title)) throw new Error('new name missing from title');
    done++;
  } catch (e) { fail++; failures.push({ id: s.id, oldName: s.oldName, newName: s.newName, err: e.message }); }
  if (n % 50 === 0) console.log(`  ...${n}/${plan.length} (done ${done}, fail ${fail})`);
});

console.log(`\nRelabeled+verified: ${done} | failed: ${fail}`);
if (failures.length) { console.log('Failures:'); failures.slice(0, 30).forEach((f) => console.log(`  • ${f.oldName}->${f.newName} (${f.id}): ${f.err}`)); }
const c = await shopifyGraphQL(`query{ productsCount{count} }`, {});
console.log(`Store product count: ${c.productsCount.count}`);

/**
 * Multi-collection dress orchestrator (Juniper Lane 8 sub-collections).
 *
 * One physical dress = ONE product, linked into every sub-collection it belongs
 * to (never duplicated). Computes each unique dress's full membership across all
 * sources FIRST, so length (from mini/midi/maxi) and occasion (from beach/evening
 * + source title) context are correct at build time. Reuses the tested pipeline:
 * dedup, QA gate, per-product categorization, charm pricing, image-coverage, etc.
 *
 *   node --env-file=.env scripts/multi-collection-dresses.js [--dry-run] [--max N] [--execute] [--publish]
 */

'use strict';

import { fetchShopifyProductJson } from '../src/scrape/apify.js'; // (retry helper reused indirectly)
import { mapApifyToInput } from '../src/transform/apifyToInput.js';
import { buildProductDraft } from '../src/pipeline.js';
import { runQAGate } from '../src/validate/qaGate.js';
import { makeNameAllocator } from '../src/content/names.js';
import { ensureCollection, addProductsToCollection } from '../src/shopify/collections.js';
import { executeProductSet } from '../src/shopify/execute.js';
import { publishToSalesChannels } from '../src/shopify/publish.js';
import { shopifyGraphQL } from '../src/shopify/client.js';

const ORIGIN = 'https://www.byjuniperlane.com';
const SUBS = [
  { slug: 'mini-dresses-women', coll: 'Mini Dresses', length: 'Mini' },
  { slug: 'midi-dresses-women', coll: 'Midi Dresses', length: 'Midi' },
  { slug: 'maxi-dresses-women', coll: 'Maxi Dresses', length: 'Maxi' },
  { slug: 'sleeveless-dresses', coll: 'Sleeveless Dresses' },
  { slug: 'short-sleeve-dresses', coll: 'Short Sleeve Dresses' },
  { slug: 'long-sleeve-dresses-women', coll: 'Long Sleeve Dresses' },
  { slug: 'beach-dresses-women', coll: 'Beach Dresses', occasion: 'beach' },
  { slug: 'evening-dresses-women', coll: 'Evening Dresses', occasion: 'evening' },
];
const CONCURRENCY = 6;
const CHUNK = 120;
const DRY = process.argv.includes('--dry-run');
const PUBLISH = process.argv.includes('--publish');
const MAX = process.argv.includes('--max') ? Number(process.argv[process.argv.indexOf('--max') + 1]) : Infinity;

const imageToken = (u) => (String(u || '').split('?')[0].split('/').pop() || '').replace(/^\d+_/, '').toLowerCase();
const tokensFrom = (imgs) => [...new Set((imgs || []).map((im) => imageToken(im.src || im.url || im)).filter(Boolean))];
const nameFromTitle = (t) => (String(t || '').includes(' | ') ? t.split(' | ').pop().trim() : '');
async function mapPool(items, limit, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } })); }

async function fetchAll(slug) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const b = await (await fetch(`${ORIGIN}/collections/${slug}/products.json?limit=250&page=${page}`)).json();
    const ps = b.products || []; out.push(...ps);
    if (ps.length < 250) break;
  }
  return out;
}

console.log(`→ multi-collection dresses (${DRY ? 'DRY-RUN' : 'EXECUTE' + (PUBLISH ? '+PUBLISH' : '')})\n`);

// 1) Build the unique-dress membership map across all 8 sub-collections.
const byHandle = new Map();
for (const sub of SUBS) {
  const ps = await fetchAll(sub.slug);
  for (const p of ps) {
    if (!byHandle.has(p.handle)) byHandle.set(p.handle, { raw: p, colls: new Set(), lengths: new Set(), occasions: new Set() });
    const e = byHandle.get(p.handle);
    e.colls.add(sub.coll);
    if (sub.length) e.lengths.add(sub.length);
    if (sub.occasion) e.occasions.add(sub.occasion);
  }
  console.log(`  fetched ${ps.length} from ${sub.coll}`);
}
console.log(`\nUnique dresses: ${byHandle.size}`);

// 2) Store fingerprint (token -> {id, colls}) + names for unique allocation.
let after = null; const tokenMap = new Map(); const storeNames = [];
do {
  const d = await shopifyGraphQL(`query($a:String){ products(first:100,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title collections(first:25){nodes{title}} media(first:40){nodes{... on MediaImage{image{url}}}} } } }`, { a: after });
  for (const p of d.products.nodes) {
    const nm = nameFromTitle(p.title); if (nm) storeNames.push(nm);
    const colls = new Set(p.collections.nodes.map((c) => c.title));
    for (const m of p.media.nodes) { const t = imageToken(m.image?.url); if (t && !tokenMap.has(t)) tokenMap.set(t, { id: p.id, title: p.title, colls }); }
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);
console.log(`Store fingerprints: ${tokenMap.size}, names reserved: ${storeNames.length}`);

// 3) Classify: link existing vs build new.
const allocator = makeNameAllocator(storeNames);
const toBuild = []; const toLink = []; const held = []; const buildSkipped = [];
for (const [handle, e] of byHandle) {
  const targetColls = [...e.colls];
  const tokens = tokensFrom(e.raw.images);
  const existing = tokens.map((t) => tokenMap.get(t)).find(Boolean);
  if (existing) { const missing = targetColls.filter((c) => !existing.colls.has(c)); if (missing.length) toLink.push({ id: existing.id, title: existing.title, colls: missing }); continue; }
  const lengthContext = e.lengths.size ? [...e.lengths][0] : undefined;
  const occasionTags = [...e.occasions];
  let input;
  try { ({ input } = mapApifyToInput(e.raw, { trustImages: true, linkage: e.raw, sourceCurrency: 'CAD', group: targetColls[0], lengthContext, occasionTags })); }
  catch (err) { buildSkipped.push({ title: e.raw.title, reason: `map failed: ${err.message}` }); continue; }
  // Single-colorway dresses come through as "Default" — keep them (real dresses,
  // image via main-image fallback); the QA image gate still drops any photoless one.
  if (input.colors.length === 1 && input.colors[0] === 'Default') held.push({ title: e.raw.title });
  input.name = allocator.take(input.name);
  toBuild.push({ handle, raw: e.raw, input, targetColls });
  if (toBuild.length >= MAX) break;
}
console.log(`\nPlan: build ${toBuild.length} new | link ${toLink.length} existing | held ${held.length} | map-skipped ${buildSkipped.length}`);

if (DRY) {
  console.log('\n— sample (first 8) —');
  for (const s of toBuild.slice(0, 8)) {
    const d = await buildProductDraft(s.input, { generate: async () => ({ name: s.input.name, descriptionHtml: `<p>${s.input.name}.</p>`, seo: { title: 'x', description: 'y' } }), collectionOccasion: false });
    console.log(`  ${d.title}`);
    console.log(`     cat=${d.category.id} | len=${s.input.attributes?.length || '-'} | occasion=${JSON.stringify(d.occasionTags || [])} | colls=[${s.targetColls.join(', ')}]`);
  }
  console.log('\n🔶 DRY-RUN: no writes.');
  process.exit(0);
}

// 4) Ensure all 8 collections exist (create empty up front).
const collId = {};
for (const sub of SUBS) collId[sub.coll] = (await ensureCollection(sub.coll)).id;

// 5) Link existing dresses into their new collections (grouped per collection).
const linkByColl = new Map();
for (const l of toLink) for (const c of l.colls) { if (!linkByColl.has(c)) linkByColl.set(c, []); linkByColl.get(c).push(l.id); }
for (const [c, ids] of linkByColl) { try { await addProductsToCollection(collId[c], ids, { skipGuard: true }); } catch (e) { console.log(`  link err ${c}: ${e.message}`); } }
console.log(`Linked ${toLink.length} existing dress(es) into new collections.`);

// 6) Build + create in chunks (parallel copy-gen; QA strict; multi-collection assign).
const created = []; const qaSkipped = []; const occCount = {};
let chunkNo = 0;
for (let start = 0; start < toBuild.length; start += CHUNK) {
  chunkNo++;
  const chunk = toBuild.slice(start, start + CHUNK);
  const built = [];
  await mapPool(chunk, CONCURRENCY, async (s) => {
    try { s.draft = await buildProductDraft(s.input, { collectionOccasion: false }); built.push(s); }
    catch (err) { buildSkipped.push({ title: s.raw.title, reason: `build: ${err.message}` }); }
  });
  const gate = runQAGate(built.map((s) => s.draft), { requireCollectionKeyword: false });
  built.forEach((s, i) => { s.qa = gate[i]; });
  let madeThis = 0;
  for (const s of built) {
    if (!s.qa.ok) { qaSkipped.push({ title: s.draft.title, reason: s.qa.errors.join('; ') }); continue; }
    try {
      const ids = s.targetColls.map((c) => collId[c]);
      const exec = await executeProductSet(s.draft, { status: 'ACTIVE', collectionIds: ids, collectionTags: s.targetColls });
      if (PUBLISH) await publishToSalesChannels(exec.product.id);
      created.push({ id: exec.product.id, colls: s.targetColls });
      for (const o of (s.draft.occasionTags || [])) occCount[o] = (occCount[o] || 0) + 1;
      madeThis++;
    } catch (err) { buildSkipped.push({ title: s.draft.title, reason: `create: ${err.message}` }); }
  }
  console.log(`CHUNK ${chunkNo}: created ${madeThis}/${chunk.length} | qa-skipped(running) ${qaSkipped.length} | total created ${created.length}`);
}

// 7) Final report.
console.log('\n================ FINAL REPORT ================');
console.log(`Unique dresses: ${byHandle.size} | created new: ${created.length} | linked existing: ${toLink.length} | held: ${held.length} | qa-skipped: ${qaSkipped.length} | other-skipped: ${buildSkipped.length}`);
console.log('\nQA-skipped:'); qaSkipped.slice(0, 50).forEach((s) => console.log(`  • ${s.title} — ${s.reason}`));
console.log('\nHeld:'); held.forEach((s) => console.log(`  • ${s.title} — ${s.reason}`));
console.log('\nMap/build/create errors:'); buildSkipped.slice(0, 50).forEach((s) => console.log(`  • ${s.title} — ${s.reason}`));
console.log('\nOccasion tag distribution:', JSON.stringify(occCount));
console.log('EXIT=0');

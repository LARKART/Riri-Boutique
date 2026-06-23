/**
 * Multi-collection tops orchestrator (Juniper Lane 3 sleeve sub-collections).
 *
 * One physical top = ONE product, linked into every sleeve sub-collection it
 * belongs to (never duplicated). Store-wide image-fingerprint dedup LINKS any
 * top that already exists in the store (e.g. our existing Blouses collection)
 * into the matching sleeve collection instead of recreating it, and only the
 * genuinely-new tops are built. Non-top pollution (slippers, etc.) is filtered.
 * Reuses the tested pipeline: dedup, QA gate, per-product categorization (Tops/
 * Blouses node, never aa-1-4), charm CAD pricing, image-coverage, feed metafields.
 *
 *   node --env-file=.env scripts/multi-collection-tops.js [--dry-run] [--max N] [--execute] [--publish]
 */

'use strict';

import { mapApifyToInput } from '../src/transform/apifyToInput.js';
import { buildProductDraft } from '../src/pipeline.js';
import { runQAGate } from '../src/validate/qaGate.js';
import { makeNameAllocator } from '../src/content/names.js';
import { ensureCollection, addProductsToCollection } from '../src/shopify/collections.js';
import { executeProductSet } from '../src/shopify/execute.js';
import { publishToSalesChannels, verifyPublished } from '../src/shopify/publish.js';
import { shopifyGraphQL } from '../src/shopify/client.js';

const ORIGIN = 'https://www.byjuniperlane.com';
const SUBS = [
  { slug: 'sleeveless-tops-women', coll: 'Sleeveless Tops', sleeve: 'Sleeveless' },
  { slug: 'short-sleeve-tops-women', coll: 'Short Sleeve Tops', sleeve: 'Short Sleeve' },
  { slug: 'long-sleeve-tops-women', coll: 'Long Sleeve Tops', sleeve: 'Long Sleeve' },
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

console.log(`→ multi-collection tops (${DRY ? 'DRY-RUN' : 'EXECUTE' + (PUBLISH ? '+PUBLISH' : '')})\n`);

// 1) Build the unique-top membership map across the 3 sleeve sub-collections.
const byHandle = new Map();
for (const sub of SUBS) {
  const ps = await fetchAll(sub.slug);
  for (const p of ps) {
    if (!byHandle.has(p.handle)) byHandle.set(p.handle, { raw: p, colls: new Set(), sleeves: new Set() });
    const e = byHandle.get(p.handle);
    e.colls.add(sub.coll);
    if (sub.sleeve) e.sleeves.add(sub.sleeve);
  }
  console.log(`  fetched ${ps.length} from ${sub.coll}`);
}
console.log(`\nUnique tops (by handle): ${byHandle.size}`);

// 2) Store fingerprint (token -> {id, title, colls}) + names for unique allocation.
let after = null; const tokenMap = new Map(); const storeNames = []; let storeCount = 0;
do {
  const d = await shopifyGraphQL(`query($a:String){ products(first:100,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title collections(first:25){nodes{title}} media(first:40){nodes{... on MediaImage{image{url}}}} } } }`, { a: after });
  for (const p of d.products.nodes) {
    storeCount++;
    const nm = nameFromTitle(p.title); if (nm) storeNames.push(nm);
    const colls = new Set(p.collections.nodes.map((c) => c.title));
    for (const m of p.media.nodes) { const t = imageToken(m.image?.url); if (t && !tokenMap.has(t)) tokenMap.set(t, { id: p.id, title: p.title, colls }); }
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);
console.log(`Store products: ${storeCount} | fingerprints: ${tokenMap.size} | names reserved: ${storeNames.length}`);

// 3) Classify: link existing (incl. Blouses) vs build new vs junk.
const allocator = makeNameAllocator(storeNames);
const toBuild = []; const toLink = []; const junk = []; const mapSkipped = []; const heldNoColor = [];
const runSeen = new Set(); // within-run image fingerprints (no two builds share photos)
for (const [handle, e] of byHandle) {
  const targetColls = [...e.colls];
  const tokens = tokensFrom(e.raw.images);
  const existing = tokens.length ? tokens.map((t) => tokenMap.get(t)).find(Boolean) : null;
  if (existing) {
    const missing = targetColls.filter((c) => !existing.colls.has(c));
    if (missing.length) toLink.push({ id: existing.id, title: existing.title, colls: missing, fromBlouses: existing.colls.has('Blouses') });
    continue;
  }
  if (!tokens.length) { mapSkipped.push({ title: e.raw.title, reason: 'no images to fingerprint (skipped to be safe)' }); continue; }
  if (tokens.some((t) => runSeen.has(t))) { mapSkipped.push({ title: e.raw.title, reason: 'duplicate of another top earlier in this run' }); continue; }
  const sleeveContext = e.sleeves.size ? [...e.sleeves][0] : undefined;
  let input;
  try { ({ input } = mapApifyToInput(e.raw, { trustImages: true, linkage: e.raw, sourceCurrency: 'CAD', group: targetColls[0], sleeveContext })); }
  catch (err) { mapSkipped.push({ title: e.raw.title, reason: `map failed: ${err.message}` }); continue; }
  // Junk filter: anything not actually a top (slippers, etc.) is dropped + reported.
  if (!input.isTop) { junk.push({ title: e.raw.title, detected: input.productType }); continue; }
  // No real color and no pattern -> "Default"; keep (real top, image via fallback);
  // the QA image gate still drops any photoless one.
  if (input.colors.length === 1 && input.colors[0] === 'Default') heldNoColor.push({ title: e.raw.title });
  input.name = allocator.take(input.name);
  tokens.forEach((t) => runSeen.add(t)); // reserve this build's photos against later dups
  toBuild.push({ handle, raw: e.raw, input, targetColls });
  if (toBuild.length >= MAX) break;
}
const linkedFromBlouses = toLink.filter((l) => l.fromBlouses).length;
console.log(`\nPlan: build NEW ${toBuild.length} | link EXISTING ${toLink.length} (of which from Blouses: ${linkedFromBlouses}) | junk ${junk.length} | held-no-color ${heldNoColor.length} | map-skipped ${mapSkipped.length}`);
console.log(`Dedup proof: store should rise by ~${toBuild.length}, NOT ~${byHandle.size}.`);

if (junk.length) { console.log('\n— junk (filtered, not built) —'); for (const j of junk) console.log(`  • ${j.title} — detected "${j.detected}"`); }

if (DRY) {
  console.log('\n— sample (first 10 new) —');
  for (const s of toBuild.slice(0, 10)) {
    const d = await buildProductDraft(s.input, { generate: async () => ({ name: s.input.name, descriptionHtml: `<p>${s.input.name}.</p>`, seo: { title: 'x', description: 'y' } }), collectionOccasion: false });
    console.log(`  ${d.title}`);
    console.log(`     cat=${d.category.id} | sleeve=${s.input.attributes?.sleeve || '-'} | colls=[${s.targetColls.join(', ')}]`);
  }
  console.log('\n🔶 DRY-RUN: no writes.');
  process.exit(0);
}

// 4) Ensure all 3 collections exist (create empty up front).
const collId = {};
for (const sub of SUBS) collId[sub.coll] = (await ensureCollection(sub.coll)).id;

// 5) Link existing tops (incl. Blouses) into their new sleeve collections.
const linkByColl = new Map();
for (const l of toLink) for (const c of l.colls) { if (!linkByColl.has(c)) linkByColl.set(c, []); linkByColl.get(c).push(l.id); }
for (const [c, ids] of linkByColl) { try { await addProductsToCollection(collId[c], ids, { skipGuard: true }); } catch (e) { console.log(`  link err ${c}: ${e.message}`); } }
console.log(`Linked ${toLink.length} existing top(s) into sleeve collections (${linkedFromBlouses} from Blouses).`);

// 6) Build + create in chunks (parallel copy-gen; QA strict; multi-collection assign + publish).
const created = []; const qaSkipped = []; const buildSkipped = [];
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
      created.push({ id: exec.product.id, title: s.draft.title, colls: s.targetColls });
      madeThis++;
    } catch (err) { buildSkipped.push({ title: s.draft.title, reason: `create: ${err.message}` }); }
  }
  console.log(`CHUNK ${chunkNo}: created ${madeThis}/${chunk.length} | qa-skipped(running) ${qaSkipped.length} | total created ${created.length}`);
}

// 7) Publish verification (read-back).
let live = 0;
if (PUBLISH && created.length) {
  const checks = await verifyPublished(created.map((c) => c.id));
  live = checks.filter((c) => c.live).length;
}

// 8) Final report.
console.log('\n================ FINAL REPORT — TOPS ================');
console.log(`Unique tops: ${byHandle.size}`);
console.log(`  created NEW:        ${created.length}${PUBLISH ? ` (live ${live}/${created.length})` : ''}`);
console.log(`  linked EXISTING:   ${toLink.length} (from Blouses: ${linkedFromBlouses})`);
console.log(`  junk filtered:     ${junk.length}`);
console.log(`  qa-skipped:        ${qaSkipped.length}`);
console.log(`  build/create-skip: ${buildSkipped.length}`);
console.log(`  held-no-color:     ${heldNoColor.length}`);
console.log(`  map-skipped:       ${mapSkipped.length}`);
console.log(`\nDedup proof: created ~${created.length} new (not ~${byHandle.size}); ${toLink.length} existing linked, not duplicated.`);
if (qaSkipped.length) { console.log('\nQA-skipped:'); qaSkipped.slice(0, 50).forEach((s) => console.log(`  • ${s.title} — ${s.reason}`)); }
if (buildSkipped.length) { console.log('\nBuild/create errors:'); buildSkipped.slice(0, 50).forEach((s) => console.log(`  • ${s.title} — ${s.reason}`)); }
if (junk.length) { console.log('\nJunk filtered:'); junk.forEach((j) => console.log(`  • ${j.title} — detected "${j.detected}"`)); }
console.log('EXIT=0');

/**
 * Add products from one or more source URLs into a single collection, de-duped.
 *
 * Scrapes every URL, fingerprints products already in the target collection by
 * source image identity (the image filename UUID is preserved when Shopify
 * re-hosts), and skips any scraped product that matches one already live OR a
 * duplicate earlier in the same run (across all URLs). Survivors are built
 * through the normal pipeline (unique naming seeded from the collection, length
 * + color/pattern rules, QA gate).
 *
 * The collection is created-or-reused once and every survivor routes into it.
 * Writes are OFF by default (dry-run gate). With --execute it creates the new
 * survivors; with --publish it sets them ACTIVE, publishes, and verifies live.
 *
 *   node --env-file=.env scripts/add-from-url-deduped.js --collection "Name" \
 *        [--occasion "X"] [--limit N] [--execute] [--publish] <url> [<url> ...]
 */

'use strict';

import { scrapeProducts, fetchShopifyProductJson } from '../src/scrape/apify.js';
import { mapApifyToInput } from '../src/transform/apifyToInput.js';
import { buildProductDraft, finalizeProduct } from '../src/pipeline.js';
import { makeNameAllocator } from '../src/content/names.js';
import { runQAGate } from '../src/validate/qaGate.js';
import { ensureCollection, addProductsToCollection } from '../src/shopify/collections.js';
import { executeProductSet } from '../src/shopify/execute.js';
import { verifyPublished } from '../src/shopify/publish.js';
import { buildProductSetOperation } from '../src/shopify/payload-builder.js';
import { shopifyGraphQL } from '../src/shopify/client.js';

// --- arg parsing: flags (some take a value) + positional URLs ----------------
const VALUE_FLAGS = new Set(['--collection', '--occasion', '--limit', '--source-currency', '--concurrency', '--require-kind']);
const BOOL_FLAGS = new Set(['--execute', '--publish', '--include-no-color', '--no-occasion', '--skip-failed']);
const opts = {}; const urls = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (VALUE_FLAGS.has(a)) { opts[a.slice(2)] = process.argv[++i]; }
  else if (BOOL_FLAGS.has(a)) { opts[a.slice(2)] = true; }
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
  else urls.push(a);
}
const collectionName = opts.collection;
const occasion = opts.occasion;            // explicit keyword override (else derived from collection)
const noOccasion = !!opts['no-occasion'];  // opt out of the collection-keyword rule for this run
const skipFailed = !!opts['skip-failed'];  // skip QA-failing products instead of aborting the batch
const sourceCurrency = opts['source-currency']; // force source currency (e.g. USD) for FX
const concurrency = Math.max(1, Math.min(10, Number(opts.concurrency) || 6)); // parallel copy-gen (speed only)
const requireKind = opts['require-kind']; // skip products that aren't this kind (polluted sources): top|shorts|dress|set|swim|footwear
const limit = opts.limit ? Number(opts.limit) : undefined; // per-URL cap
const includeNoColor = !!opts['include-no-color'];
const execute = !!opts.execute;
const publish = !!opts.publish;

if (!collectionName || urls.length === 0) {
  console.error('Usage: node --env-file=.env scripts/add-from-url-deduped.js --collection "Name" [--occasion "X"] [--limit N] [--execute] [--publish] <url> [<url> ...]');
  process.exit(2);
}

/** Stable per-image identity across stores: filename minus position prefix + query. */
function imageToken(u) {
  const base = String(u || '').split('?')[0].split('/').pop() || '';
  return base.replace(/^\d+_/, '').toLowerCase(); // "1_<uuid>.png" -> "<uuid>.png"
}
function tokensFrom(images) {
  return [...new Set((images || []).map((im) => imageToken(im.src || im.url || im)).filter(Boolean))];
}
/** Run async fn over items with a fixed concurrency limit (order-independent). */
async function mapPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

/** Product name = the part after " | " in the generated title. */
function nameFromTitle(title) {
  const t = String(title || '');
  return t.includes(' | ') ? t.split(' | ').pop().trim() : '';
}

/**
 * Fingerprint the existing collection (if it exists): image token -> product
 * title, plus the names already in use. Non-fatal when the collection is new.
 */
async function fetchExisting(name) {
  const q = `query($q:String!,$after:String){
    collections(first:1, query:$q){ nodes{ id title
      products(first:50, after:$after){ pageInfo{hasNextPage endCursor}
        nodes{ title media(first:50){ nodes{ ... on MediaImage { image { url } } } } } } } } }`;
  const tokenToTitle = new Map(); const names = [];
  let after = null; let collId = null; let collTitle = null;
  do {
    const d = await shopifyGraphQL(q, { q: `title:"${name}"`, after });
    const coll = d.collections.nodes[0];
    if (!coll) break;
    collId = coll.id; collTitle = coll.title;
    for (const p of coll.products.nodes) {
      const nm = nameFromTitle(p.title); if (nm) names.push(nm);
      for (const m of p.media.nodes) { const t = imageToken(m.image?.url); if (t) tokenToTitle.set(t, p.title); }
    }
    after = coll.products.pageInfo.hasNextPage ? coll.products.pageInfo.endCursor : null;
  } while (after);
  return { tokenToTitle, names, collId, collTitle };
}

/**
 * Store-wide index: every product's names (for unique allocation) and an image
 * fingerprint -> { id, collections } map (to dedupe across the whole store and
 * link an already-created product into a new collection instead of duplicating).
 */
async function fetchStoreIndex() {
  const q = `query($after:String){ products(first:100, after:$after){ pageInfo{hasNextPage endCursor}
    nodes{ id title collections(first:20){ nodes{ title } } media(first:40){ nodes{ ... on MediaImage { image { url } } } } } } }`;
  const names = []; const tokenMap = new Map();
  let after = null;
  do {
    const d = await shopifyGraphQL(q, { after });
    for (const p of d.products.nodes) {
      const n = nameFromTitle(p.title); if (n) names.push(n);
      const colls = new Set(p.collections.nodes.map((c) => c.title));
      for (const m of p.media.nodes) { const t = imageToken(m.image?.url); if (t && !tokenMap.has(t)) tokenMap.set(t, { id: p.id, title: p.title, colls }); }
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return { names, tokenMap };
}

console.log(`→ add-from-url-deduped (writes ${execute ? 'ON' : 'OFF'}${publish ? ', PUBLISH/ACTIVE' : ''})`);
console.log(`  collection : "${collectionName}"`);
urls.forEach((u, i) => console.log(`  url ${i + 1}      : ${u}`));
if (occasion) console.log(`  occasion   : titles/SEO will include "${occasion}"`);
console.log('');

// 1) Index the whole store: names (for unique allocation) + image fingerprints
// (for store-wide dedup and linking existing products into this collection).
const { collId, collTitle } = await fetchExisting(collectionName);
const { names: storeNames, tokenMap } = await fetchStoreIndex();
console.log(collId
  ? `Existing collection: ${collTitle} (${collId}).`
  : `Collection "${collectionName}" does not exist yet — it will be created on --execute.`);
console.log(`Store index: ${tokenMap.size} image fingerprints, ${new Set(storeNames.map((n) => n.toLowerCase())).size} names reserved.\n`);

// 2) Scrape every URL, tagging each item with its source URL.
const items = [];
for (const url of urls) {
  // Default to a high maxItems so an uncapped run scrapes the whole collection
  // (the actor otherwise defaults to ~100, silently truncating large sources).
  const { items: got } = await scrapeProducts(url, { actorInput: { startUrls: [{ url }], maxItems: limit || 250 } });
  const slice = limit ? got.slice(0, limit) : got;
  slice.forEach((raw) => items.push({ raw, url }));
  console.log(`Scraped ${slice.length} from ${url}`);
}
console.log('');

// Per-source currency (handles mixed-currency merges, e.g. CAD + USD): explicit
// --source-currency wins, else read the shop's meta.json, else default in mapper.
const urlCurrency = new Map();
for (const url of urls) {
  let cur = sourceCurrency;
  if (!cur) { try { const m = await (await fetch(`${new URL(url).origin}/meta.json`)).json(); if (/^(CAD|USD)$/i.test(m.currency)) cur = m.currency.toUpperCase(); } catch { /* */ } }
  urlCurrency.set(url, cur);
}
console.log(`Source currencies: ${[...urlCurrency].map(([u, c]) => `${new URL(u).host}=${c || 'auto'}`).join(', ')}\n`);

// 3) Classify the batch — SEQUENTIAL so dedup/link/hold/name allocation stay
// ordered and exactly as strict (no concurrency races on these decisions).
const allocator = makeNameAllocator(storeNames); // unique vs every existing product
const survivors = [];
const skipped = [];
const held = [];
const linked = []; // already exist elsewhere in the store -> link into this collection, don't duplicate
const toBuild = []; // passed dedup; copy generation happens in parallel below
const seenThisRun = new Map(); // token -> source title (cross+within-URL dedup)
const perUrl = new Map(urls.map((u) => [u, { scraped: 0, added: 0, linked: 0, skipped: 0, held: 0 }]));
for (const { raw, url } of items) {
  const stat = perUrl.get(url); stat.scraped++;
  let origin = null; try { origin = new URL(url).origin; } catch { /* */ }
  let linkage = null;
  if (origin && raw.handle) { try { linkage = await fetchShopifyProductJson(origin, raw.handle); } catch { /* */ } }
  const tokens = tokensFrom(linkage?.images || raw.images);

  const existing = tokens.map((t) => tokenMap.get(t)).find(Boolean);
  if (existing) {
    if (existing.colls.has(collectionName)) { skipped.push({ raw, url, reason: `already in "${collectionName}" as "${existing.title}"` }); stat.skipped++; }
    else { linked.push({ raw, url, id: existing.id, title: existing.title, from: [...existing.colls] }); stat.linked++; }
    continue;
  }
  const runHit = tokens.find((t) => seenThisRun.has(t));
  if (runHit) { skipped.push({ raw, url, reason: `duplicate of "${seenThisRun.get(runHit)}" earlier in this run` }); stat.skipped++; continue; }
  if (tokens.length === 0) { skipped.push({ raw, url, reason: 'no images to fingerprint (skipped to be safe)' }); stat.skipped++; continue; }

  const { input, unverifiedImages, notes } = mapApifyToInput(raw, { trustImages: true, linkage, referenceUrl: url, group: collectionName, sourceCurrency: urlCurrency.get(url) });

  // Pollution filter: drop products that aren't the expected kind (e.g. a slipper
  // in a Blouses source). Reported so nothing slips through silently.
  if (requireKind) {
    const kind = { top: input.isTop, shorts: input.isShorts, pants: input.isPants, skirt: input.isSkirt, dress: input.isDress, set: input.isSet, swim: input.isSwim, footwear: input.isFootwear }[requireKind];
    if (!kind) { skipped.push({ raw, url, reason: `not a ${requireKind} (source pollution; detected "${input.productType}")` }); stat.skipped++; continue; }
  }

  // Hold products with no real color AND no pattern (-> ["Default"]).
  if (input.colors.length === 1 && input.colors[0] === 'Default' && !includeNoColor) {
    held.push({ raw, url, reason: 'no real color or pattern at source' }); stat.held++; continue;
  }

  tokens.forEach((t) => seenThisRun.set(t, raw.title));
  input.group = collectionName; // so the collection keyword is derived correctly
  input.name = allocator.take(input.name);
  toBuild.push({ raw, url, input, notes, unverifiedImages });
}

// 3b) Generate copy in PARALLEL — speed only. Dedup/naming already done above;
// every draft still goes through the full QA gate below, unchanged.
console.log(`Generating copy for ${toBuild.length} product(s) with concurrency ${concurrency}...`);
await mapPool(toBuild, concurrency, async (s) => {
  try {
    const draft = await buildProductDraft(s.input, { collectionOccasion: !noOccasion, occasionOverride: occasion });
    draft.collection.title = collectionName;
    s.draft = draft;
    survivors.push(s);
    perUrl.get(s.url).added++;
  } catch (err) {
    skipped.push({ raw: s.raw, url: s.url, reason: `build failed: ${err.message}` });
    perUrl.get(s.url).skipped++;
  }
});

// 4) Pre-publish QA gate — runs on EVERY built draft, identical to sequential mode.
const gate = runQAGate(survivors.map((s) => s.draft), { requireCollectionKeyword: !noOccasion });
survivors.forEach((s, i) => { s.qa = gate[i]; });
const qaFailed = gate.some((g) => !g.ok);

// 5) Report.
console.log('— per URL —');
for (const [u, s] of perUrl) console.log(`  ${u}\n     scraped ${s.scraped} | added ${s.added} | linked ${s.linked} | skipped ${s.skipped} | held ${s.held}`);
console.log(`\nTOTAL unique NEW: ${survivors.length} | linked (existing→collection): ${linked.length} | skipped: ${skipped.length} | held: ${held.length}`);

if (linked.length) { console.log('\n— linked (already in store, added to this collection, not duplicated) —'); for (const l of linked) console.log(`  • ${l.title} — exists in [${l.from.join(', ')}]`); }
if (skipped.length) { console.log('\n— skipped —'); for (const s of skipped) console.log(`  • ${s.raw.title} — ${s.reason}`); }
if (held.length) { console.log('\n— held for your decision —'); for (const h of held) console.log(`  • ${h.raw.title} — ${h.reason}`); }

console.log('\n— new products + QA —');
survivors.forEach((s, i) => {
  console.log(`  ${i + 1}. ${s.draft.title}`);
  console.log(`       variants ${s.draft.variants.length} | sample ${s.draft.variants[0]?.sku} $${s.draft.variants[0]?.price}/$${s.draft.variants[0]?.compareAtPrice} | colors ${s.input.colors.join('|')}${s.input.pattern ? ` | pattern ${s.input.pattern}${s.input.feedColor ? `→feed ${s.input.feedColor}` : ''}` : ''}`);
  console.log(`       QA: ${s.qa.ok ? '✅ pass' : '❌ ' + s.qa.errors.join('; ')}`);
});

if (survivors[0]) {
  const op = buildProductSetOperation(survivors[0].draft, { status: execute && publish ? 'ACTIVE' : 'DRAFT' });
  console.log('\n=== sample payload (product 1) ===');
  console.log(JSON.stringify(op.variables.input, null, 2));
}

// 6) Dry-run gate.
if (!execute) {
  console.log('\n🔶 DRY-RUN GATE: no products were created. Review above and approve before executing.');
  if (qaFailed) { console.log('❌ QA gate found problems — resolve before executing.'); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}

// 7) Execute into the one collection. By default the gate is fail-closed for the
// whole batch; with --skip-failed, QA failures are skipped and the rest publish.
const qaSkipped = survivors.filter((s) => !s.qa.ok);
const toCreate = skipFailed ? survivors.filter((s) => s.qa.ok) : survivors;
if (qaFailed && !skipFailed) {
  console.log('\n⛔ QA gate failed — refusing to write anything (fail-closed). Re-run with --skip-failed to publish the passing ones.');
  process.exit(1);
}
if (qaSkipped.length) {
  console.log(`\n⚠️  Skipping ${qaSkipped.length} product(s) that FAILED the QA gate:`);
  for (const s of qaSkipped) console.log(`  • ${s.draft.title} (source: ${s.raw.title}) — ${s.qa.errors.join('; ')}`);
}
if (!toCreate.length && !linked.length) { console.log('\nNothing to create or link. Done.'); process.exit(qaSkipped.length ? 1 : 0); }

const collection = await ensureCollection(collectionName); // create-or-reuse

// Link products that already exist elsewhere into this collection (no duplicates).
if (linked.length) {
  console.log(`\n→ Linking ${linked.length} existing product(s) into "${collection.title}"...`);
  try {
    await addProductsToCollection(collection.id, linked.map((l) => l.id), { skipGuard: true });
    for (const l of linked) console.log(`  🔗 ${l.title}`);
  } catch (err) { console.log(`  ❌ link failed: ${err.message}`); }
}

const status = publish ? 'ACTIVE' : 'DRAFT';
console.log(`\n→ Creating ${toCreate.length} product(s) as ${status} in "${collection.title}"...`);
const created = [];
for (const s of toCreate) {
  try {
    const exec = await executeProductSet(s.draft, { status, collectionId: collection.id });
    await finalizeProduct(exec.product.id, s.draft, { publish, collection });
    created.push({ id: exec.product.id, title: s.draft.title });
    console.log(`  ✅ ${s.draft.title} -> ${exec.product.id}`);
  } catch (err) {
    console.log(`  ❌ ${s.draft.title}: ${err.message}`);
  }
}

// 8) Verify live (when publishing).
if (publish && created.length) {
  const checks = await verifyPublished(created.map((c) => c.id));
  const byId = new Map(checks.map((c) => [c.id, c]));
  console.log('\n— publish verification —');
  let notLive = 0;
  for (const c of created) {
    const v = byId.get(c.id); const ok = v?.live; if (!ok) notLive++;
    console.log(`  ${ok ? '✅' : '❌'} ${c.title} -> status=${v?.status} pub=${v?.publicationCount} publishedAt=${v?.publishedAt ? 'yes' : 'NO'}`);
  }
  console.log(`\nLive ${created.length - notLive}/${created.length} | QA-skipped ${qaSkipped.length} | create-errors ${toCreate.length - created.length}.`);
  if (notLive || created.length !== toCreate.length) process.exitCode = 1;
}

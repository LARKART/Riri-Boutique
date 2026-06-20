/**
 * Add products from a URL into an EXISTING collection, de-duplicated.
 *
 * Scrapes a source collection URL, fingerprints the products already in the
 * target Shopify collection by their source image identity (the image filename
 * UUID is preserved when Shopify re-hosts), and skips any scraped product that
 * matches one already live (or a duplicate earlier in the same run). Survivors
 * are built through the normal pipeline (unique naming, transforms, QA gate).
 *
 * Writes are OFF by default (dry-run gate). With --execute it creates ONLY the
 * new survivors, routed into the existing collection (verified, never created
 * anew here beyond ensureCollection's verify-or-create), and with --publish
 * sets them ACTIVE and publishes, then verifies each is live.
 *
 *   node --env-file=.env scripts/add-from-url-deduped.js "<url>" "<collection>" [--limit N] [--execute] [--publish]
 */

'use strict';

import { scrapeProducts, fetchShopifyProductJson } from '../src/scrape/apify.js';
import { mapApifyToInput } from '../src/transform/apifyToInput.js';
import { buildProductDraft, finalizeProduct } from '../src/pipeline.js';
import { makeNameAllocator } from '../src/content/names.js';
import { runQAGate } from '../src/validate/qaGate.js';
import { ensureCollection } from '../src/shopify/collections.js';
import { executeProductSet } from '../src/shopify/execute.js';
import { verifyPublished } from '../src/shopify/publish.js';
import { buildProductSetOperation } from '../src/shopify/payload-builder.js';
import { shopifyGraphQL } from '../src/shopify/client.js';

const url = process.argv[2];
const collectionName = process.argv[3];
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const limit = arg('--limit') ? Number(arg('--limit')) : undefined;
const occasion = arg('--occasion'); // align title/SEO to the collection (e.g. "Wedding Guest")
const includeNoColor = process.argv.includes('--include-no-color'); // build products whose only color is a pattern
const execute = process.argv.includes('--execute');
const publish = process.argv.includes('--publish');

if (!url || !collectionName) {
  console.error('Usage: node --env-file=.env scripts/add-from-url-deduped.js "<url>" "<collection>" [--limit N] [--execute] [--publish]');
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

/** Product name = the part after " | " in the generated title. */
function nameFromTitle(title) {
  const t = String(title || '');
  return t.includes(' | ') ? t.split(' | ').pop().trim() : '';
}

/**
 * Fingerprint the existing collection: image token -> product title, plus the
 * set of product names already in use (so we never re-allocate a colliding name).
 */
async function fetchExisting(name) {
  const q = `query($q:String!,$after:String){
    collections(first:1, query:$q){ nodes{ id title
      products(first:50, after:$after){ pageInfo{hasNextPage endCursor}
        nodes{ title media(first:50){ nodes{ ... on MediaImage { image { url } } } } } } } } }`;
  const tokenToTitle = new Map();
  const names = [];
  let after = null; let collId = null; let collTitle = null;
  do {
    const d = await shopifyGraphQL(q, { q: `title:"${name}"`, after });
    const coll = d.collections.nodes[0];
    if (!coll) break;
    collId = coll.id; collTitle = coll.title;
    for (const p of coll.products.nodes) {
      const nm = nameFromTitle(p.title); if (nm) names.push(nm);
      for (const m of p.media.nodes) {
        const t = imageToken(m.image?.url);
        if (t) tokenToTitle.set(t, p.title);
      }
    }
    after = coll.products.pageInfo.hasNextPage ? coll.products.pageInfo.endCursor : null;
  } while (after);
  return { tokenToTitle, names, collId, collTitle };
}

console.log(`→ add-from-url-deduped (writes ${execute ? 'ON' : 'OFF'}${publish ? ', PUBLISH/ACTIVE' : ''})`);
console.log(`  url        : ${url}`);
console.log(`  collection : "${collectionName}" (existing — reused, not recreated)\n`);

// 1) Fingerprint the existing collection (image identity + names in use).
const { tokenToTitle, names: existingNames, collId, collTitle } = await fetchExisting(collectionName);
if (!collId) { console.error(`❌ Collection "${collectionName}" not found. Aborting (won't create a new one).`); process.exit(1); }
console.log(`Existing collection: ${collTitle} (${collId}); ${tokenToTitle.size} image fingerprints, ${existingNames.length} names in use.`);
if (occasion) console.log(`Occasion override: titles/SEO will include "${occasion}".`);
console.log('');

// 2) Scrape the source URL.
const { items } = await scrapeProducts(url, { actorInput: { startUrls: [{ url }], ...(limit ? { maxItems: limit } : {}) } });
const slice = limit ? items.slice(0, limit) : items;
let origin = null; try { origin = new URL(url).origin; } catch { /* */ }

// 3) Classify each scraped product: new vs duplicate (existing or within-run).
// Seed the allocator with names already in the collection so no name collides.
const allocator = makeNameAllocator(existingNames);
const survivors = [];
const skipped = [];
const held = [];          // no real color at source (e.g. only "Floral") — await decision
const seenThisRun = new Map(); // token -> source title (within-URL dedup)
for (const raw of slice) {
  let linkage = null;
  if (origin && raw.handle) { try { linkage = await fetchShopifyProductJson(origin, raw.handle); } catch { /* */ } }
  const tokens = tokensFrom(linkage?.images || raw.images);

  const existHit = tokens.find((t) => tokenToTitle.has(t));
  if (existHit) { skipped.push({ raw, reason: `already live as "${tokenToTitle.get(existHit)}"` }); continue; }
  const runHit = tokens.find((t) => seenThisRun.has(t));
  if (runHit) { skipped.push({ raw, reason: `duplicate within this URL of "${seenThisRun.get(runHit)}"` }); continue; }
  if (tokens.length === 0) { skipped.push({ raw, reason: 'no images to fingerprint (skipped to be safe)' }); continue; }

  // Map first so we can inspect the resolved (allowlisted) colors.
  const { input, unverifiedImages, notes } = mapApifyToInput(raw, { trustImages: true, linkage, referenceUrl: url, group: collectionName });

  // Hold products whose only color is a dropped pattern (-> ["Default"]).
  const noRealColor = input.colors.length === 1 && input.colors[0] === 'Default';
  if (noRealColor && !includeNoColor) {
    held.push({ raw, reason: 'no real color at source (only a pattern e.g. "Floral")' });
    continue;
  }

  tokens.forEach((t) => seenThisRun.set(t, raw.title));
  try {
    // 2a — align title/SEO to the collection's occasion (no other claims invented).
    if (occasion && input.isDress) {
      input.attributes = { ...(input.attributes || {}), occasion };
    }
    input.name = allocator.take(input.name); // 2b — unique vs existing collection
    const draft = await buildProductDraft(input);
    draft.collection.title = collectionName; // route into the existing collection
    survivors.push({ raw, input, draft, notes, unverifiedImages });
  } catch (err) {
    skipped.push({ raw, reason: `build failed: ${err.message}` });
  }
}

// 4) Pre-publish QA gate on survivors.
const gate = runQAGate(survivors.map((s) => s.draft));
survivors.forEach((s, i) => { s.qa = gate[i]; });
const qaFailed = gate.some((g) => !g.ok);

// 5) Report.
console.log(`Scraped ${slice.length} | NEW ${survivors.length} | SKIPPED ${skipped.length} | HELD ${held.length}\n`);
console.log('— skipped (duplicates / not buildable) —');
if (!skipped.length) console.log('  (none)');
for (const s of skipped) console.log(`  • ${s.raw.title}  —  ${s.reason}`);
console.log('\n— held for your decision (no real color at source) —');
if (!held.length) console.log('  (none)');
for (const h of held) console.log(`  • ${h.raw.title}  —  ${h.reason}`);

console.log('\n— new products + QA —');
survivors.forEach((s, i) => {
  console.log(`  ${i + 1}. ${s.draft.title}`);
  console.log(`       variants ${s.draft.variants.length} | sample ${s.draft.variants[0]?.sku} $${s.draft.variants[0]?.price}/$${s.draft.variants[0]?.compareAtPrice} | colors ${s.input.colors.join('|')}`);
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

// 7) Execute (only survivors), routed into the existing collection.
if (qaFailed) { console.log('\n⛔ QA gate failed — refusing to write anything (fail-closed).'); process.exit(1); }
if (!survivors.length) { console.log('\nNothing new to add. Done.'); process.exit(0); }

const collection = await ensureCollection(collectionName); // verify-or-create (exists -> reused)
const status = publish ? 'ACTIVE' : 'DRAFT';
console.log(`\n→ Creating ${survivors.length} product(s) as ${status} in "${collection.title}"...`);
const created = [];
for (const s of survivors) {
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
    const v = byId.get(c.id);
    const ok = v?.live;
    if (!ok) notLive++;
    console.log(`  ${ok ? '✅' : '❌'} ${c.title} -> status=${v?.status} pub=${v?.publicationCount} publishedAt=${v?.publishedAt ? 'yes' : 'NO'}`);
  }
  console.log(`\nLive ${created.length - notLive}/${created.length}.`);
  if (notLive || created.length !== survivors.length) process.exitCode = 1;
}

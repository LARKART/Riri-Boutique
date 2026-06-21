/**
 * Core pipeline orchestrator (lifecycle Stages 1-7).
 *
 * Ingest -> Validate -> AI content -> Transform core -> Taxonomy/Feed ->
 * Image processing + variant mapping  =>  canonical ProductDraft.
 *
 * This stops BEFORE payload construction (Stage 8) and mutation (Stage 10) —
 * it produces the enriched draft that the productSet builder will consume.
 * Dependencies (Claude content, Shopify taxonomy lookup) are injectable so the
 * deterministic stages can run offline in tests.
 */

'use strict';

import { pathToFileURL } from 'node:url';
import { validateProductInput } from './validate/input.js';
import { generateContent as defaultGenerate } from './content/generate.js';
import { buildTitle, titleCore } from './transform/title.js';
import { buildVariants } from './normalize/variants.js';
import { resolveCategory } from './transform/taxonomy.js';
import { buildFeedMetafields } from './transform/feed.js';
import { processImages } from './images/process.js';
import { buildFxFromEnv } from './transform/currency.js';
import { executeProductSet } from './shopify/execute.js';
import { ensureCollection, addProductsToCollection } from './shopify/collections.js';
import { publishToSalesChannels, verifyPublished } from './shopify/publish.js';
import { makeNameAllocator } from './content/names.js';
import { runQAGate } from './validate/qaGate.js';
import { collectionKeyword, insertKeywordBeforeLength } from './transform/occasion.js';

/**
 * Build the canonical ProductDraft for one input product.
 * @param {object} input hand-authored product JSON
 * @param {object} [deps]
 * @param {(draft)=>Promise<{name,descriptionHtml,seo}>} [deps.generate] content generator
 * @param {(q,v?)=>Promise<object>} [deps.gql] Shopify GraphQL for taxonomy lookup
 * @param {Function[]} [deps.imageDetectors] image QA detectors
 * @returns {Promise<object>} ProductDraft
 */
export async function buildProductDraft(input, deps = {}) {
  const generate = deps.generate || defaultGenerate;

  // Stage 2 — validate the input contract (errors block).
  const { valid, errors, warnings: inputWarnings } = validateProductInput(input);
  if (!valid) {
    throw new Error(`Input failed validation:\n - ${errors.join('\n - ')}`);
  }

  const draft = { ...input, attributes: input.attributes || {} };

  // Collection occasion keyword (e.g. "Summer Dresses" -> "Summer", "Summer Sets"
  // -> "Summer"): inject into the title's occasion slot so the title (and SEO)
  // carry the collection term — for dresses AND sets. Enabled by default;
  // deps.collectionOccasion === false opts out, deps.occasionOverride forces one.
  if (deps.collectionOccasion !== false) {
    const kw = deps.occasionOverride || collectionKeyword(draft.group);
    if (kw) draft.attributes = { ...draft.attributes, occasion: kw };
  }
  const occasionKw = draft.attributes.occasion;

  // Stage 6 — AI content (invented name, original description, SEO).
  const content = await generate(draft);
  draft.name = draft.name || content.name; // keep an author-supplied name if present

  // Guarantee the SEO title also carries the keyword (model copy may omit it).
  if (occasionKw && content.seo?.title) {
    content.seo.title = insertKeywordBeforeLength(content.seo.title, occasionKw);
  }

  // Stage 5/4 — title (deterministic) + variant matrix (price/compareAt/SKU).
  // FX conversion (spec §13) applies when source currency != store currency.
  const title = buildTitle(draft);
  // Never ship an empty SEO title — fall back to the keyword-first product title.
  if (!content.seo) content.seo = {};
  if (!String(content.seo.title || '').trim()) content.seo.title = title;
  // Footwear / shorts / blouses: SEO title mirrors the product title exactly.
  if (draft.isFootwear || draft.isShorts || draft.isTop) content.seo.title = title;
  const variants = buildVariants(draft, { fx: deps.fx || buildFxFromEnv() });

  // Stage 5 — taxonomy + GMC feed fields (pattern + inferred base color for prints).
  const category = await resolveCategory(draft, deps.gql);
  const feedMetafields = buildFeedMetafields({ pattern: draft.pattern, color: draft.feedColor });

  // Stage 7 — images + variant color mapping.
  const images = await processImages(draft, { detectors: deps.imageDetectors });

  // Attach the per-color default image to each variant.
  const variantsWithImages = variants.map((v) => ({
    ...v,
    image: images.variantImageByColor[v.color] || null,
  }));

  return {
    title,
    name: draft.name,
    productType: draft.productType,
    isDress: draft.isDress,
    descriptionHtml: content.descriptionHtml,
    seo: content.seo,
    category,
    options: [
      { name: 'Color', values: draft.colors },
      { name: 'Size', values: draft.sizes },
    ],
    variants: variantsWithImages,
    media: images.media,
    mainSrc: images.mainSrc,
    feedMetafields,
    inventoryTracked: false, // spec 7
    collection: {
      title: draft.group,
      sortOrder: 'BEST_SELLING',
    },
    altText: images.altText,
    qa: {
      titleCore: titleCore(draft),
      rejectedImages: images.rejected,
      warnings: dedupeWarnings([...inputWarnings, ...images.warnings]),
    },
  };
}

/**
 * Resolve the create status. Publishing implies ACTIVE: publishablePublish is a
 * silent no-op on a DRAFT product, so a product that will be published must be
 * created ACTIVE. An explicit opts.status always wins; otherwise default DRAFT.
 * @param {{status?: 'DRAFT'|'ACTIVE', publish?: boolean}} opts
 * @returns {'DRAFT'|'ACTIVE'}
 */
function resolveStatus(opts = {}) {
  return opts.status || (opts.publish ? 'ACTIVE' : 'DRAFT');
}

/**
 * Post-creation finalize (lifecycle Stages 11 + 12): verify/create the group's
 * collection, assign the product, and optionally publish to sales channels.
 * The identity guard runs once (inside ensureCollection); later calls skip it.
 * @param {string} productId gid://shopify/Product/...
 * @param {object} draft canonical ProductDraft (uses draft.collection.title)
 * @param {{publish?: boolean, collection?: {id,title}}} [opts] publish=false by
 *   default; pass a pre-resolved `collection` to skip the verify/create round-trip.
 */
export async function finalizeProduct(productId, draft, opts = {}) {
  // Stage 11 — collection verify/create + assign (reuse pre-resolved if given).
  const collection = opts.collection || await ensureCollection(draft.collection.title);
  const assignJob = await addProductsToCollection(collection.id, [productId], { skipGuard: true });

  // Stage 12 — optional broadcast to Online Store + Google sales channels.
  // The caller must have created the product ACTIVE (see resolveStatus);
  // publishablePublish silently no-ops on a DRAFT product.
  let publish = null;
  if (opts.publish) publish = await publishToSalesChannels(productId);

  return { collection, assignJob, publish };
}

/**
 * Full single-product run: build -> verify/create collection -> execute (DRAFT,
 * routed into the collection) -> finalize.
 * Publishing is opt-in (default off) so an unapproved product is never broadcast.
 * @param {object} input hand-authored product JSON
 * @param {{status?: 'DRAFT'|'ACTIVE', publish?: boolean, collection?: string, deps?: object}} [opts]
 */
export async function runProduct(input, opts = {}) {
  // Decide the authoritative name up front so title, SKU, and copy all agree.
  const named = { ...input, name: makeNameAllocator().take(input.name) };
  const draft = await buildProductDraft(named, {
    ...(opts.deps || {}),
    collectionOccasion: opts.collectionOccasion,
    occasionOverride: opts.occasion,
  });
  if (opts.collection) draft.collection.title = opts.collection; // dynamic routing override
  const collection = await ensureCollection(draft.collection.title); // verify or create
  const exec = await executeProductSet(draft, { status: resolveStatus(opts), collectionId: collection.id });
  const finalized = await finalizeProduct(exec.product.id, draft, { publish: !!opts.publish, collection });
  return { draft, ...exec, ...finalized };
}

/**
 * Collapse near-duplicate warnings. The input validator and the image processor
 * can both flag the same per-color image gap with different wording/casing
 * ("no mapped image" lowercased vs "no approved image" original-case); normalize
 * so each distinct issue is reported once.
 */
function dedupeWarnings(warnings) {
  const seen = new Map();
  for (const w of warnings) {
    const key = w.toLowerCase().replace(/has no (mapped|approved) image/, 'has no image');
    if (!seen.has(key)) seen.set(key, w);
  }
  return [...seen.values()];
}

/**
 * Stage 0 entry: scrape a URL, map each scraped product into our input contract,
 * and run it through the existing ingest pipeline (buildProductDraft).
 *
 * Writes are OFF by default — this returns drafts for review. Pass execute:true
 * to also create products (Stage 10 + finalize). Scraped images are quarantined
 * unless map.trustImages is set (spec §9.3/§17).
 *
 * @param {string} url target URL (structural reference)
 * @param {object} [opts]
 * @param {object} [opts.scrape] options forwarded to scrapeProducts
 * @param {object} [opts.map]    options forwarded to mapApifyToInput
 * @param {object} [opts.deps]   injected deps for buildProductDraft
 * @param {boolean} [opts.execute=false] also create + finalize each product
 * @param {boolean} [opts.publish=false] publish each product (implies ACTIVE)
 * @param {'DRAFT'|'ACTIVE'} [opts.status] explicit create status (overrides the
 *   publish-implied default; see resolveStatus)
 * @param {number}  [opts.limit] cap how many scraped products to process
 * @returns {Promise<Array<{input, draft, unverifiedImages, notes, execution?}>>}
 */
export async function runPipelineFromUrl(url, opts = {}) {
  // Dynamic import keeps apify-client out of the offline script paths.
  const { scrapeProducts, fetchShopifyProductJson } = await import('./scrape/apify.js');
  const { mapApifyToInput } = await import('./transform/apifyToInput.js');

  const { items } = await scrapeProducts(url, opts.scrape || {});
  const slice = opts.limit ? items.slice(0, opts.limit) : items;

  const wantLinkage = !!(opts.map && opts.map.trustImages);
  let origin = null;
  try { origin = new URL(url).origin; } catch { /* non-URL input */ }

  // Phase 1 — build all drafts (NO writes). Each product's unique name is
  // assigned UP FRONT (before copy/SKU/title) so all three agree and no name
  // carries over between products. Resilient: a failed product is recorded as
  // buildError and skipped, not fatal to the batch (spec §15).
  const allocator = makeNameAllocator();
  const results = [];
  for (const raw of slice) {
    try {
      let linkage = null;
      if (wantLinkage && origin && raw.handle) {
        try { linkage = await fetchShopifyProductJson(origin, raw.handle); }
        catch { /* fall back to gallery-only images */ }
      }
      const mapOpts = { referenceUrl: url, ...(opts.map || {}), linkage };
      if (!mapOpts.sourceCurrency && linkage?.variants?.[0]?.price_currency) {
        mapOpts.sourceCurrency = linkage.variants[0].price_currency;
      }
      const { input, unverifiedImages, notes } = mapApifyToInput(raw, mapOpts);
      input.name = allocator.take(input.name); // authoritative, batch-unique
      const draft = await buildProductDraft(input, {
        ...(opts.deps || {}),
        collectionOccasion: opts.collectionOccasion,
        occasionOverride: opts.occasion,
      });
      if (opts.collection) draft.collection.title = opts.collection; // dynamic routing override
      results.push({ input, draft, unverifiedImages, notes });
    } catch (err) {
      results.push({ raw: { title: raw.title, handle: raw.handle }, notes: [], buildError: err.message });
    }
  }

  // Phase 2 — pre-publish QA gate (fail-closed). Validate every built draft;
  // attach per-product errors. Writes are blocked below if ANY product fails.
  const built = results.filter((r) => r.draft);
  const gate = runQAGate(built.map((r) => r.draft), { requireCollectionKeyword: opts.collectionOccasion !== false });
  built.forEach((r, i) => { r.qa = gate[i]; if (!gate[i].ok) r.qaErrors = gate[i].errors; });
  const qaFailed = results.some((r) => r.qaErrors) || results.some((r) => r.buildError);

  // Phase 3 — optional execution. Skipped entirely if QA failed: never publish a
  // batch that contains a broken product (the gate is the safety net).
  if (opts.execute && qaFailed) {
    return results; // caller (CLI) reports failures and exits non-zero
  }
  if (opts.execute) {
    const status = resolveStatus(opts); // --publish implies ACTIVE
    const collCache = new Map(); // verify/create each collection once per batch
    const resolveCollection = async (name) => {
      if (!collCache.has(name)) collCache.set(name, await ensureCollection(name));
      return collCache.get(name);
    };
    for (const r of results) {
      if (!r.draft) continue;
      try {
        const collection = await resolveCollection(r.draft.collection.title);
        const exec = await executeProductSet(r.draft, { status, collectionId: collection.id });
        r.execution = { ...exec, ...(await finalizeProduct(exec.product.id, r.draft, { publish: !!opts.publish, collection })) };
      } catch (err) {
        r.execError = err.message;
      }
    }
  }
  return results;
}

export { titleCore };

// ---------------------------------------------------------------------------
// CLI: node src/pipeline.js --url "<URL>" [--collection "Name"] [--limit N]
//                           [--execute] [--publish]
// Writes are OFF unless --execute is passed (dry-run gate). Images use the
// standing supplier attestation (trustImages). --collection routes all products
// into the named collection (verified or created on the fly). --publish creates
// products ACTIVE and publishes them to the Online Store (+ any other installed
// channels), then verifies each is live and exits non-zero if any is not.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.url) {
    console.error('Usage: node src/pipeline.js --url "<URL>" [--collection "Name"] [--limit N] [--execute] [--publish]');
    process.exit(2);
  }
  const collection = typeof a.collection === 'string' ? a.collection : undefined;
  const limit = a.limit ? Number(a.limit) : undefined;
  const execute = !!a.execute;
  const publish = !!a.publish;

  console.log(`→ pipeline --url ${a.url}${collection ? ` --collection "${collection}"` : ''}` +
    `${limit ? ` --limit ${limit}` : ''} | ${execute ? 'EXECUTE (writes)' : 'DRY-RUN (no writes)'}` +
    `${publish ? ' | PUBLISH (status ACTIVE)' : ''}`);

  const results = await runPipelineFromUrl(a.url, {
    collection,
    limit,
    execute,
    publish, // implies status ACTIVE (see resolveStatus); no --publish => DRAFT
    scrape: { actorInput: { startUrls: [{ url: a.url }], ...(limit ? { maxItems: limit } : {}) } },
    map: { trustImages: true }, // standing owner supplier attestation (see CLAUDE.md)
  });

  for (const r of results) {
    if (r.execution?.product) {
      console.log(`✅ ${r.draft.title} -> ${r.execution.product.id} [collection: ${r.execution.collection?.title}]`);
    } else if (r.execError) {
      console.log(`❌ ${r.draft?.title || r.raw?.title || '?'}: ${r.execError}`);
    } else if (r.buildError) {
      console.log(`❌ ${r.raw?.title || '?'}: ${r.buildError}`);
    } else if (r.draft) {
      console.log(`• ${r.draft.title} -> collection "${r.draft.collection.title}"${r.qaErrors ? ' [QA FAIL]' : ''}`);
    }
  }

  // Pre-publish QA gate report. Fail loudly (non-zero exit) on any QA or build
  // failure; in execute mode this also means NOTHING was written.
  const qaFails = results.filter((r) => r.qaErrors);
  const buildFails = results.filter((r) => r.buildError);
  if (qaFails.length || buildFails.length) {
    console.log('\n❌ PRE-PUBLISH QA GATE FAILED:');
    for (const r of buildFails) console.log(`  • ${r.raw?.title || '?'} (build): ${r.buildError}`);
    for (const r of qaFails) {
      console.log(`  • ${r.draft.title}:`);
      for (const e of r.qaErrors) console.log(`      - ${e}`);
    }
    if (execute) console.log('\n⛔ No products were created or published (gate is fail-closed).');
    process.exitCode = 1;
    return;
  }
  console.log(`\n✅ QA gate: ${results.filter((r) => r.qa?.ok).length}/${results.filter((r) => r.draft).length} products passed.`);

  if (!execute) {
    console.log('\n🔶 DRY-RUN GATE: no writes. Re-run with --execute to create products.');
    return;
  }

  // Post-publish verification: read back each created product and fail loud if
  // any did not end up live (ACTIVE + on >=1 publication). publishablePublish
  // reports no error on a DRAFT product, so reading back is the only proof.
  if (publish) {
    const createdIds = results.filter((r) => r.execution?.product).map((r) => r.execution.product.id);
    const checks = await verifyPublished(createdIds);
    const byId = new Map(checks.map((c) => [c.id, c]));
    console.log('\n— publish verification —');
    let notLive = 0;
    for (const id of createdIds) {
      const c = byId.get(id);
      if (!c) { console.log(`❌ ${id}: not found on read-back`); notLive++; continue; }
      const mark = c.live ? '✅' : '❌';
      if (!c.live) notLive++;
      console.log(`${mark} ${c.title} -> status=${c.status} pub=${c.publicationCount} publishedAt=${c.publishedAt ? 'yes' : 'NO'}`);
    }
    const execFailures = results.filter((r) => r.execError || r.buildError).length;
    console.log(`\nLive ${createdIds.length - notLive}/${createdIds.length}` +
      `${execFailures ? `, ${execFailures} build/exec failure(s)` : ''}.`);
    if (notLive > 0 || execFailures > 0) {
      process.exitCode = 1; // fail-loud: not every product is live
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

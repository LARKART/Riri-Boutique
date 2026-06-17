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
import { publishToSalesChannels } from './shopify/publish.js';

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

  // Stage 6 — AI content (invented name, original description, SEO).
  const content = await generate(draft);
  draft.name = draft.name || content.name; // keep an author-supplied name if present

  // Stage 5/4 — title (deterministic) + variant matrix (price/compareAt/SKU).
  // FX conversion (spec §13) applies when source currency != store currency.
  const title = buildTitle(draft);
  const variants = buildVariants(draft, { fx: deps.fx || buildFxFromEnv() });

  // Stage 5 — taxonomy + GMC feed fields.
  const category = await resolveCategory(draft, deps.gql);
  const feedMetafields = buildFeedMetafields();

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
 * Post-creation finalize (lifecycle Stages 11 + 12): verify/create the group's
 * collection, assign the product, and optionally publish to sales channels.
 * The identity guard runs once (inside ensureCollection); later calls skip it.
 * @param {string} productId gid://shopify/Product/...
 * @param {object} draft canonical ProductDraft (uses draft.collection.title)
 * @param {{publish?: boolean}} [opts] publish=false by default (broadcast is opt-in)
 */
export async function finalizeProduct(productId, draft, opts = {}) {
  // Stage 11 — collection verify/create + assign.
  const collection = await ensureCollection(draft.collection.title);
  const assignJob = await addProductsToCollection(collection.id, [productId], { skipGuard: true });

  // Stage 12 — optional broadcast to Online Store + Google sales channels.
  let publish = null;
  if (opts.publish) publish = await publishToSalesChannels(productId);

  return { collection, assignJob, publish };
}

/**
 * Full single-product run: build -> execute (DRAFT) -> finalize.
 * Publishing is opt-in (default off) so an unapproved product is never broadcast.
 * @param {object} input hand-authored product JSON
 * @param {{status?: 'DRAFT'|'ACTIVE', publish?: boolean, deps?: object}} [opts]
 */
export async function runProduct(input, opts = {}) {
  const draft = await buildProductDraft(input, opts.deps || {});
  const exec = await executeProductSet(draft, { status: opts.status || 'DRAFT' });
  const finalized = await finalizeProduct(exec.product.id, draft, { publish: !!opts.publish });
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

/** Brand-style fallback names for cross-batch dedup (spec §14.3). */
const NAME_POOL = ['Serane', 'Elowen', 'Marielle', 'Avora', 'Celina', 'Evadra', 'Lirelle',
  'Noemi', 'Calla', 'Vesper', 'Ondine', 'Amaris', 'Sorrel', 'Thalia', 'Maren', 'Linnea',
  'Cosette', 'Delphine', 'Isolde', 'Rhea', 'Mirabel', 'Yvaine', 'Solene', 'Anouk'];

/** Ensure invented product names are unique within a batch; fixes titles too. */
function dedupeNames(entries) {
  const used = new Set();
  for (const r of entries) {
    if (!r.draft) continue;
    let name = r.draft.name;
    if (used.has(String(name).toLowerCase())) {
      const alt = NAME_POOL.find((n) => !used.has(n.toLowerCase())) || `${name}-${used.size}`;
      r.notes.push(`Renamed "${name}" -> "${alt}" for uniqueness (§14.3).`);
      name = alt;
      r.draft.name = name;
      r.draft.title = `${r.draft.title.split(' | ')[0]} | ${name}`;
    }
    used.add(String(name).toLowerCase());
  }
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

  // Phase 1 — build all drafts (NO writes). Resilient: a failed product is
  // recorded as buildError and skipped, not fatal to the batch (spec §15).
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
      const draft = await buildProductDraft(input, opts.deps || {});
      results.push({ input, draft, unverifiedImages, notes });
    } catch (err) {
      results.push({ raw: { title: raw.title, handle: raw.handle }, notes: [], buildError: err.message });
    }
  }

  // Phase 2 — unique invented names across the batch (spec §14.3).
  dedupeNames(results);

  // Phase 3 — optional execution. Resilient: per-product try/catch so one
  // failure doesn't abort the rest; created IDs and errors are both captured.
  if (opts.execute) {
    for (const r of results) {
      if (!r.draft) continue;
      try {
        const exec = await executeProductSet(r.draft, { status: opts.status || 'DRAFT' });
        r.execution = { ...exec, ...(await finalizeProduct(exec.product.id, r.draft, { publish: !!opts.publish })) };
      } catch (err) {
        r.execError = err.message;
      }
    }
  }
  return results;
}

export { titleCore };

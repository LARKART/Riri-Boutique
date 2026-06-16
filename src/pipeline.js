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
  const title = buildTitle(draft);
  const variants = buildVariants(draft);

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
      warnings: [...inputWarnings, ...images.warnings],
    },
  };
}

export { titleCore };

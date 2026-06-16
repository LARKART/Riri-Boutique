/**
 * productSet payload builder (lifecycle Stage 8).
 *
 * Maps a canonical ProductDraft (from src/pipeline.js) into the ProductSetInput
 * required by the Admin GraphQL `productSet` mutation, nesting:
 *   - title, descriptionHtml, productType, SEO
 *   - taxonomy category
 *   - productOptions (Color, Size)
 *   - the variant matrix (price, compareAtPrice, sku, inventory tracking off)
 *   - product files (media) + per-variant image association by originalSource
 *   - GMC feed metafields
 *
 * Products are created as DRAFT here; publishing to Online Store + Google is a
 * later stage (after QA), per the spec's pilot rules.
 */

'use strict';

export const PRODUCT_SET_MUTATION = `
mutation ProductSetDryRun($input: ProductSetInput!, $synchronous: Boolean) {
  productSet(input: $input, synchronous: $synchronous) {
    product {
      id
      title
      status
      handle
    }
    userErrors {
      field
      message
      code
    }
  }
}`.trim();

/** Format a number as a Shopify Decimal money string ("93.95"). */
function money(n) {
  return Number(n).toFixed(2);
}

/**
 * Build the ProductSetInput from a ProductDraft.
 * @param {object} draft canonical draft from buildProductDraft()
 * @param {{status?: 'DRAFT'|'ACTIVE', vendor?: string}} [opts]
 * @returns {object} ProductSetInput
 */
export function buildProductSetInput(draft, opts = {}) {
  const status = opts.status || 'DRAFT';
  const vendor = opts.vendor || 'Riri Boutique';

  // Product-level media: one file per approved image, alt = colorless title core.
  const files = (draft.media || []).map((m) => ({
    originalSource: m.src,
    alt: m.altText,
    contentType: 'IMAGE',
  }));

  const productOptions = (draft.options || []).map((o, i) => ({
    name: o.name,
    position: i + 1,
    values: o.values.map((v) => ({ name: v })),
  }));

  const variants = (draft.variants || []).map((v) => {
    const variant = {
      optionValues: [
        { optionName: 'Color', name: v.color },
        { optionName: 'Size', name: v.size },
      ],
      price: money(v.price),
      compareAtPrice: money(v.compareAtPrice),
      sku: v.sku,
      // spec 7: tracking OFF; CONTINUE keeps the variant sellable/servable for GMC.
      inventoryItem: { tracked: false },
      inventoryPolicy: 'CONTINUE',
    };
    // Associate the variant's color image to a product file by matching source.
    if (v.image) variant.file = { originalSource: v.image };
    return variant;
  });

  const input = {
    title: draft.title,
    descriptionHtml: draft.descriptionHtml,
    productType: draft.productType,
    vendor,
    status,
    productOptions,
    variants,
  };

  if (draft.category?.id) input.category = draft.category.id;
  if (draft.seo?.title || draft.seo?.description) {
    input.seo = { title: draft.seo.title, description: draft.seo.description };
  }
  if (files.length) input.files = files;
  if (draft.feedMetafields?.length) input.metafields = draft.feedMetafields;

  return input;
}

/**
 * Build the full GraphQL operation (query + variables) for the productSet call.
 * @returns {{query: string, variables: {input: object, synchronous: boolean}}}
 */
export function buildProductSetOperation(draft, opts = {}) {
  return {
    query: PRODUCT_SET_MUTATION,
    variables: {
      input: buildProductSetInput(draft, opts),
      synchronous: true,
    },
  };
}

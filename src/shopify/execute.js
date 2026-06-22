/**
 * Product execution (lifecycle Stage 10).
 *
 * Runs the productSet mutation to create/update a product, but ONLY after the
 * Stage 3 store-identity guard passes (fail-closed: never writes to the wrong
 * store). Returns the created product + variant IDs for logging and rollback
 * (spec 15).
 */

'use strict';

import { shopifyGraphQL } from './client.js';
import { assertStoreIdentity } from './identityGuard.js';
import { buildProductSetInput } from './payload-builder.js';

// Richer return than the dry-run mutation: include variant + media status so we
// can log IDs and verify media ingestion.
export const PRODUCT_SET_EXECUTE_MUTATION = `
mutation ProductSetExecute($input: ProductSetInput!, $synchronous: Boolean) {
  productSet(input: $input, synchronous: $synchronous) {
    product {
      id
      title
      status
      handle
      variants(first: 100) { nodes { id sku title } }
      media(first: 50) { nodes { mediaContentType status } }
    }
    userErrors { field message code }
  }
}`.trim();

/**
 * Execute productSet behind the identity guard.
 * @param {object} draft canonical ProductDraft
 * @param {{status?: 'DRAFT'|'ACTIVE', synchronous?: boolean, collectionId?: string}} [opts]
 * @returns {Promise<{shop, product, variants}>}
 */
export async function executeProductSet(draft, opts = {}) {
  // Stage 3 — refuse to write unless we're on the expected store.
  const shop = await assertStoreIdentity();

  const input = buildProductSetInput(draft, { status: opts.status || 'DRAFT', collectionId: opts.collectionId, collectionIds: opts.collectionIds, collectionTags: opts.collectionTags });
  const variables = { input, synchronous: opts.synchronous ?? true };

  const data = await shopifyGraphQL(PRODUCT_SET_EXECUTE_MUTATION, variables);
  const result = data.productSet;
  if (result.userErrors?.length) {
    throw new Error(`productSet userErrors:\n${JSON.stringify(result.userErrors, null, 2)}`);
  }
  return {
    shop,
    product: result.product,
    variants: result.product?.variants?.nodes || [],
  };
}

/** Numeric ID from a Shopify GID (gid://shopify/Product/123 -> "123"). */
export function numericId(gid) {
  return String(gid).split('/').pop();
}

/** Build the Shopify admin product URL from the shop + product GID. */
export function adminProductUrl(myshopifyDomain, productGid) {
  const handle = String(myshopifyDomain).replace('.myshopify.com', '');
  return `https://admin.shopify.com/store/${handle}/products/${numericId(productGid)}`;
}

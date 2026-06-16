/**
 * Rollback / delete safety net (lifecycle Stage 15).
 *
 * Deletes a pilot product if QA fails or review rejects it. Runs behind the
 * same store-identity guard so a delete can never hit the wrong store.
 */

'use strict';

import { shopifyGraphQL } from './client.js';
import { assertStoreIdentity } from './identityGuard.js';

export const PRODUCT_DELETE_MUTATION = `
mutation ProductDelete($input: ProductDeleteInput!) {
  productDelete(input: $input) {
    deletedProductId
    userErrors { field message }
  }
}`.trim();

/**
 * Delete a product by GID.
 * @param {string} productId gid://shopify/Product/...
 * @returns {Promise<{deletedProductId: string}>}
 */
export async function deleteProduct(productId) {
  await assertStoreIdentity(); // fail-closed
  const data = await shopifyGraphQL(PRODUCT_DELETE_MUTATION, { input: { id: productId } });
  const result = data.productDelete;
  if (result.userErrors?.length) {
    throw new Error(`productDelete userErrors:\n${JSON.stringify(result.userErrors, null, 2)}`);
  }
  return { deletedProductId: result.deletedProductId };
}

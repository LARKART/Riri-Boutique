/**
 * Store-data protection guard (lifecycle Stage 3).
 *
 * Before ANY write/mutation, assert that the connected shop's myshopifyDomain
 * matches the expected store. This prevents the pipeline from ever creating or
 * modifying products on the wrong store — the identity of the connected store
 * was ambiguous during design (credentials cited zd7csp-i7.myshopify.com while
 * the custom domain is ririboutique.com), so we fail closed.
 *
 * The expected domain is hardcoded here per the signed-off checkpoint, and may
 * be overridden via SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN for other environments.
 */

'use strict';

import { shopifyGraphQL } from './client.js';

// Hardcoded expected store. Confirm this is correct before running any mutation.
export const EXPECTED_MYSHOPIFY_DOMAIN =
  process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN || 'zd7csp-i7.myshopify.com';

const SHOP_QUERY = `query StoreIdentity { shop { name myshopifyDomain } }`;

/**
 * Verify the connected store is the expected one.
 * @returns {Promise<{name: string, myshopifyDomain: string}>}
 * @throws if the connected store does not match EXPECTED_MYSHOPIFY_DOMAIN
 */
export async function assertStoreIdentity() {
  const data = await shopifyGraphQL(SHOP_QUERY);
  const shop = data?.shop;
  if (!shop?.myshopifyDomain) {
    throw new Error('Store identity guard: could not read shop.myshopifyDomain.');
  }
  if (shop.myshopifyDomain.toLowerCase() !== EXPECTED_MYSHOPIFY_DOMAIN.toLowerCase()) {
    throw new Error(
      `Store identity guard FAILED: connected store is "${shop.myshopifyDomain}" ` +
      `but expected "${EXPECTED_MYSHOPIFY_DOMAIN}". Refusing to mutate. ` +
      `If this store is correct, update EXPECTED_MYSHOPIFY_DOMAIN ` +
      `(or set SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN).`
    );
  }
  return shop;
}

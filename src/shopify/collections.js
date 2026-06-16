/**
 * Auto collections (lifecycle Stage 11).
 *
 * Verify-or-create one collection per imported group (spec 11):
 *   - title = keyword theme (e.g. "Wedding Guest Dresses")
 *   - sortOrder = BEST_SELLING
 *   - SEO title/description generated from the keyword
 * then assign the product via collectionAddProductsV2 (async job).
 *
 * Runs behind the store-identity guard (writes only to the verified store).
 */

'use strict';

import { shopifyGraphQL } from './client.js';
import { assertStoreIdentity } from './identityGuard.js';

const FIND_COLLECTION = `
query FindCollection($q: String!) {
  collections(first: 1, query: $q) { nodes { id title handle sortOrder } }
}`.trim();

export const COLLECTION_CREATE = `
mutation CollectionCreate($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection { id title handle sortOrder }
    userErrors { field message }
  }
}`.trim();

export const COLLECTION_ADD_PRODUCTS = `
mutation CollectionAddProductsV2($id: ID!, $productIds: [ID!]!) {
  collectionAddProductsV2(id: $id, productIds: $productIds) {
    job { id done }
    userErrors { field message }
  }
}`.trim();

/** Verify a collection exists by exact title, or create it (manual, BEST_SELLING). */
export async function ensureCollection(group, { skipGuard = false } = {}) {
  if (!skipGuard) await assertStoreIdentity();
  const title = String(group).trim();

  // Verify first (spec 11: verification/creation).
  const found = await shopifyGraphQL(FIND_COLLECTION, { q: `title:'${title.replace(/'/g, "\\'")}'` });
  const existing = (found.collections?.nodes || []).find(
    (c) => c.title.toLowerCase() === title.toLowerCase()
  );
  if (existing) return { ...existing, created: false };

  const input = {
    title,
    sortOrder: 'BEST_SELLING',
    seo: {
      title: `${title} | Riri Boutique`,
      description: `Shop our ${title.toLowerCase()} collection at Riri Boutique.`,
    },
  };
  const data = await shopifyGraphQL(COLLECTION_CREATE, { input });
  const res = data.collectionCreate;
  if (res.userErrors?.length) {
    throw new Error(`collectionCreate userErrors:\n${JSON.stringify(res.userErrors, null, 2)}`);
  }
  return { ...res.collection, created: true };
}

/** Assign products to a collection (async job). */
export async function addProductsToCollection(collectionId, productIds, { skipGuard = false } = {}) {
  if (!skipGuard) await assertStoreIdentity();
  const data = await shopifyGraphQL(COLLECTION_ADD_PRODUCTS, { id: collectionId, productIds });
  const res = data.collectionAddProductsV2;
  if (res.userErrors?.length) {
    throw new Error(`collectionAddProductsV2 userErrors:\n${JSON.stringify(res.userErrors, null, 2)}`);
  }
  return res.job;
}

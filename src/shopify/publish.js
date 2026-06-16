/**
 * Channel publishing (lifecycle Stage 12).
 *
 * Publish an approved product to the Online Store and the Google sales channel
 * via publishablePublish (needs write_publications). Publication IDs are looked
 * up by name from the store's publications so we never hardcode channel IDs.
 *
 * Runs behind the store-identity guard.
 */

'use strict';

import { shopifyGraphQL } from './client.js';
import { assertStoreIdentity } from './identityGuard.js';

// Substrings (lowercased) used to match the target channels by name.
export const TARGET_CHANNEL_MATCHERS = ['online store', 'google'];

const LIST_PUBLICATIONS = `
query Publications { publications(first: 50) { nodes { id name } } }`.trim();

export const PUBLISHABLE_PUBLISH = `
mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}`.trim();

/** Look up the publication IDs for the target channels (Online Store + Google). */
export async function getTargetPublications(matchers = TARGET_CHANNEL_MATCHERS, { skipGuard = false } = {}) {
  if (!skipGuard) await assertStoreIdentity();
  const data = await shopifyGraphQL(LIST_PUBLICATIONS);
  const all = data.publications?.nodes || [];
  const matched = all.filter((p) => matchers.some((m) => p.name.toLowerCase().includes(m)));
  return { matched, all };
}

/**
 * Publish a product to the given publication IDs.
 * @param {string} productId gid://shopify/Product/...
 * @param {string[]} publicationIds
 */
export async function publishProduct(productId, publicationIds, { skipGuard = false } = {}) {
  if (!skipGuard) await assertStoreIdentity();
  if (!publicationIds?.length) throw new Error('No publication IDs to publish to.');
  const input = publicationIds.map((publicationId) => ({ publicationId }));
  const data = await shopifyGraphQL(PUBLISHABLE_PUBLISH, { id: productId, input });
  const res = data.publishablePublish;
  if (res.userErrors?.length) {
    throw new Error(`publishablePublish userErrors:\n${JSON.stringify(res.userErrors, null, 2)}`);
  }
  return { published: publicationIds.length };
}

/** Convenience: publish a product to the Online Store + Google channels. */
export async function publishToSalesChannels(productId) {
  const shop = await assertStoreIdentity();
  const { matched, all } = await getTargetPublications(TARGET_CHANNEL_MATCHERS, { skipGuard: true });
  if (matched.length === 0) {
    throw new Error(`No target channels found among: ${all.map((p) => p.name).join(', ')}`);
  }
  const result = await publishProduct(productId, matched.map((p) => p.id), { skipGuard: true });
  return { shop, channels: matched, ...result };
}

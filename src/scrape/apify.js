/**
 * Stage 0 — Apify web scraper (structural reference ingestion).
 *
 * Calls a Shopify scraper actor on Apify for a target URL, waits for the run to
 * finish, and returns the raw scraped product array. Per spec §4/§17 the output
 * is used for STRUCTURE (options, variants, colors, sizes). Scraped images and
 * copy are NOT trusted by default — see src/transform/apifyToInput.js.
 *
 * Requires APIFY_API_TOKEN and (optionally) APIFY_SHOPIFY_ACTOR_ID in the env.
 */

'use strict';

import { ApifyClient } from 'apify-client';

/**
 * Scrape products from a target URL via an Apify actor.
 * @param {string} targetUrl the page/store to scrape (structural reference)
 * @param {object} [opts]
 * @param {string} [opts.actorId]  actor ID (defaults to APIFY_SHOPIFY_ACTOR_ID)
 * @param {string} [opts.token]    Apify token (defaults to APIFY_API_TOKEN)
 * @param {object} [opts.actorInput] override/extend the actor input payload
 * @param {object} [opts.client]   injectable ApifyClient (for testing)
 * @returns {Promise<{items: object[], runId: string, datasetId: string}>}
 */
export async function scrapeProducts(targetUrl, opts = {}) {
  if (!targetUrl) throw new Error('scrapeProducts: targetUrl is required.');

  const token = opts.token || process.env.APIFY_API_TOKEN;
  const actorId = opts.actorId || process.env.APIFY_SHOPIFY_ACTOR_ID;
  if (!token) throw new Error('APIFY_API_TOKEN is not set.');
  if (!actorId) throw new Error('APIFY_SHOPIFY_ACTOR_ID is not set (or pass opts.actorId).');

  const client = opts.client || new ApifyClient({ token });

  // Default input shape used by most Shopify scraper actors; override as needed.
  const actorInput = opts.actorInput || { startUrls: [{ url: targetUrl }] };

  // .call() starts the run and resolves once it finishes.
  const run = await client.actor(actorId).call(actorInput);
  if (!run?.defaultDatasetId) {
    throw new Error(`Apify run did not return a dataset (status: ${run?.status}).`);
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return { items: items || [], runId: run.id, datasetId: run.defaultDatasetId };
}

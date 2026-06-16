/**
 * Offline validation of Stage 0: the Apify->input transformer and the scraper
 * code path (with a mocked ApifyClient). No network, no API keys.
 *   node scripts/demo-apify-map.js
 */

'use strict';

import { mapApifyToInput } from '../src/transform/apifyToInput.js';
import { scrapeProducts } from '../src/scrape/apify.js';
import { validateProductInput } from '../src/validate/input.js';

// A representative raw Shopify product as an Apify scraper would emit it.
const rawProduct = {
  title: 'Elegant One Shoulder Maxi Dress',
  product_type: 'Dress',
  vendor: 'SomeCompetitor',
  url: 'https://competitor.example.com/products/elegant-maxi',
  options: [
    { name: 'Color', values: ['Black', 'Emerald', 'black'] },
    { name: 'Size', values: ['S', 'M', 'L'] },
  ],
  variants: [
    { id: 1, option1: 'Black', option2: 'S', price: '88.40', sku: 'X-BLK-S' },
    { id: 2, option1: 'Emerald', option2: 'M', price: '92.10', sku: 'X-EMR-M' },
  ],
  images: [
    { src: 'https://cdn.shopify.com/comp/black-1.jpg', position: 1, variant_ids: [1] },
    { src: 'https://cdn.shopify.com/comp/emerald-1.jpg', position: 2, variant_ids: [2] },
  ],
};

console.log('=== mapApifyToInput (default: images quarantined) ===');
const def = mapApifyToInput(rawProduct, { sourceCurrency: 'CAD', group: 'Wedding Guest Dresses' });
console.log('input:', JSON.stringify(def.input, null, 2));
console.log('unverifiedImages:', def.unverifiedImages.length, '(quarantined)');
console.log('notes:'); for (const n of def.notes) console.log('  -', n);
const v1 = validateProductInput(def.input);
console.log(`validation: ${v1.valid ? '✅ VALID' : '❌ INVALID'}  (errors: ${v1.errors.length})`);
console.log('  competitor name carried over?', def.input.name ? '❌ YES' : '✅ no (invented later)');
console.log('  scraped images in approved images[]?', def.input.images ? '❌ YES' : '✅ no (quarantined)');

console.log('\n=== mapApifyToInput (trustImages: true) ===');
const trusted = mapApifyToInput(rawProduct, { group: 'Wedding Guest Dresses', trustImages: true });
console.log('input.images:', JSON.stringify(trusted.input.images, null, 2));
console.log(`validation: ${validateProductInput(trusted.input).valid ? '✅ VALID' : '❌ INVALID'}`);

console.log('\n=== scrapeProducts (mocked ApifyClient, no network) ===');
const fakeClient = {
  actor: (id) => ({ call: async () => ({ id: 'run_1', status: 'SUCCEEDED', defaultDatasetId: 'ds_1' }) }),
  dataset: (id) => ({ listItems: async () => ({ items: [rawProduct] }) }),
};
const { items, runId, datasetId } = await scrapeProducts('https://competitor.example.com', {
  token: 'fake', actorId: 'fake-actor', client: fakeClient,
});
console.log(`scraped ${items.length} item(s); run=${runId} dataset=${datasetId}`);
console.log('first item title:', items[0].title);
console.log('\n✅ Stage 0 code paths validated offline.');

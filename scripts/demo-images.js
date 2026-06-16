/**
 * Offline demo of Stage 7 image processing + variant mapping, and the pipeline
 * integration. No network / API calls (content + taxonomy are injected).
 *   node scripts/demo-images.js
 */

'use strict';

import { readFileSync } from 'node:fs';
import { processImages } from '../src/images/process.js';
import { buildProductDraft } from '../src/pipeline.js';

const input = JSON.parse(readFileSync('examples/serane.json', 'utf8'));

// Inject a deliberately bad image to exercise the QA gate.
const withBad = {
  ...input,
  images: [
    ...input.images,
    { src: 'https://supplier.example.com/serane-black-SALE-badge.jpg', color: 'Black', position: 4 },
    { src: 'https://supplier.example.com/serane-emerald-watermark.png', color: 'Emerald', position: 5 },
  ],
};

console.log('=== Stage 7: processImages ===');
const result = await processImages(withBad);
console.log(`alt text: "${result.altText}"`);
console.log(`main image: ${result.mainSrc}`);
console.log('\nordered media (gallery sequence preserved):');
for (const m of result.media) console.log(`  [${m.position}] ${m.main ? '★' : ' '} ${m.color ?? '-'}  ${m.src}`);
console.log('\nimages by color:');
for (const [c, list] of Object.entries(result.imagesByColor)) console.log(`  ${c}: ${list.length} -> ${list.join(', ')}`);
console.log('\nvariant image by color:');
for (const [c, src] of Object.entries(result.variantImageByColor)) console.log(`  ${c} -> ${src}`);
console.log('\nrejected by QA:');
for (const r of result.rejected) console.log(`  ✗ ${r.src}\n      ${r.reasons.join('; ')}`);
console.log('\nwarnings:', result.warnings.length ? result.warnings : '(none)');

console.log('\n=== Pipeline integration (content + taxonomy injected) ===');
const fakeGenerate = async () => ({
  name: 'Serane',
  descriptionHtml: '<p>An elegant one-shoulder maxi.</p>',
  seo: { title: "Women's One Shoulder Wedding Guest Maxi Dress", description: 'Elegant satin maxi.' },
});
const fakeGql = async () => ({ taxonomy: { categories: { nodes: [] } } }); // dress path never queries
const draft = await buildProductDraft(input, { generate: fakeGenerate, gql: fakeGql });
console.log('title:', draft.title);
console.log('category:', draft.category.id);
console.log('media count:', draft.media.length, '| main:', draft.mainSrc);
console.log('variants with images:');
for (const v of draft.variants) console.log(`  ${v.sku}  ${v.color}/${v.size}  $${v.price}/$${v.compareAtPrice}  img=${v.image}`);
console.log('qa warnings:', draft.qa.warnings.length ? draft.qa.warnings : '(none)');

/**
 * Verifies the deterministic transform core against the EXACT examples given in
 * the build spec. Run: npm run verify:transforms
 */

'use strict';

import { sellingPrice, compareAtPrice } from '../src/transform/pricing.js';
import { buildSku } from '../src/transform/sku.js';
import { buildTitle, titleCore } from '../src/transform/title.js';
import { buildVariants } from '../src/normalize/variants.js';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
}

console.log('\n§5.3 Selling price (strict charm: snaps to X4.95 / X9.95)');
check('93.31  -> 94.95', sellingPrice(93.31), 94.95);
check('104.10 -> 104.95', sellingPrice(104.10), 104.95);
check('79.99  -> 79.95', sellingPrice(79.99), 79.95);
check('80.00  -> 79.95', sellingPrice(80.00), 79.95);
check('82.00  -> 84.95', sellingPrice(82.00), 84.95);
check('87.00  -> 89.95', sellingPrice(87.00), 89.95);
check('2.00   -> 4.95 (floor)', sellingPrice(2.00), 4.95);
check('all dollar parts end in 4 or 9',
  [93.31, 104.1, 79.99, 80, 82, 87, 125.49, 150.2].every((p) => [4, 9].includes(Math.floor(sellingPrice(p)) % 10)), true);

console.log('\n§5.4 Compare-at price (selling / (1 - discount), ends in .00)');
check('99.95 @50% -> 200.00', compareAtPrice(99.95, 0.50), 200.00);
check('79.95 @40% -> 133.00', compareAtPrice(79.95, 0.40), 133.00);
check('79.95 @60% -> 200.00', compareAtPrice(79.95, 0.60), 200.00);

console.log('\n§8 SKU (RIRI-CODE-COLOR-SIZE)');
check('Serane/Black/M', buildSku('Serane', 'Black', 'M'), 'RIRI-SERANE-BLK-M');

console.log('\n§5.1 / §12 Title');
const serane = {
  isDress: true,
  productType: 'Dress',
  name: 'Serane',
  attributes: { neckline: 'One Shoulder', occasion: 'Wedding Guest', length: 'Maxi', material: 'Satin' },
};
check('Dress title', buildTitle(serane), "Women's One Shoulder Wedding Guest Maxi Dress | Serane");
check('Alt-text core (colorless)', titleCore(serane), "Women's One Shoulder Wedding Guest Maxi Dress");
check('Two-piece set', buildTitle({ isDress: false, productType: 'Two-Piece Set', name: 'Avira', attributes: { material: 'Knit' } }),
  "Women's Knit Two-Piece Set | Avira");

console.log('\nVariant matrix invariants (§14.5)');
const variants = buildVariants(serane.name ? { ...serane, sourcePrice: 93.31, colors: ['Black', 'Emerald'], sizes: ['S', 'M', 'L'] } : {});
check('2 colors x 3 sizes = 6 variants', variants.length, 6);
check('all SKUs unique', new Set(variants.map((v) => v.sku)).size, 6);
check('all selling prices end in .95', variants.every((v) => Math.round(v.price * 100) % 100 === 95), true);
check('all compare-at end in .00', variants.every((v) => Math.round(v.compareAtPrice * 100) % 100 === 0), true);
check('compare-at always > selling', variants.every((v) => v.compareAtPrice > v.price), true);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

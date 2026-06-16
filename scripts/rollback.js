/**
 * Rollback CLI (lifecycle Stage 15): delete a pilot product by GID.
 *   node --env-file=.env scripts/rollback.js gid://shopify/Product/123
 */

'use strict';

import { deleteProduct } from '../src/shopify/rollback.js';

const id = process.argv[2];
if (!id) {
  console.error('Usage: node --env-file=.env scripts/rollback.js <product-gid>');
  process.exit(2);
}

const { deletedProductId } = await deleteProduct(id);
console.log(`✅ Deleted product: ${deletedProductId}`);

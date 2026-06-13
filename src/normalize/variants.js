/**
 * Variant extraction & normalization (spec build step 3; QA 14.5).
 * Expands color x size into the full variant matrix with SKU and prices,
 * applying per-variant source-price overrides where provided.
 */

'use strict';

import { buildSku } from '../transform/sku.js';
import { sellingPrice, compareAtPrice, discountFraction, round2 } from '../transform/pricing.js';

/** Normalize an option value list: trim, de-duplicate (case-insensitive), keep order. */
export function normalizeOptionValues(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const v = String(raw).trim();
    const key = v.toLowerCase();
    if (v && !seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

/**
 * Build the full variant matrix for a product draft.
 * @returns {Array<{color,size,sku,price,compareAtPrice}>}
 */
export function buildVariants(draft) {
  const code = draft.productCode || draft.name;
  if (!code) throw new Error('Cannot build variants without name or productCode.');

  const colors = normalizeOptionValues(draft.colors);
  const sizes = normalizeOptionValues(draft.sizes);

  // One discount fraction per product so all variants share the same compare-at ratio.
  const discount = discountFraction(code);

  // Index overrides by "color|size" (lowercased).
  const overrides = new Map(
    (draft.variantOverrides || []).map((o) => [
      `${o.color.toLowerCase()}|${o.size.toLowerCase()}`,
      o.sourcePrice,
    ])
  );

  const variants = [];
  for (const color of colors) {
    for (const size of sizes) {
      const src = overrides.get(`${color.toLowerCase()}|${size.toLowerCase()}`) ?? draft.sourcePrice;
      const selling = sellingPrice(src);
      variants.push({
        color,
        size,
        sku: buildSku(code, color, size),
        price: selling,
        compareAtPrice: compareAtPrice(selling, discount),
      });
    }
  }
  return variants;
}

export { round2 };

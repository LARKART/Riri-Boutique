/**
 * Pricing transforms (spec 5.3 selling price, 5.4 compare-at price).
 *
 * Selling price: STRICT CHARM PRICING — snap to the nearest whole dollar ending
 *                in 4 or 9, then add .95, so every final price ends in 4.95 or
 *                9.95 (e.g. 93.31 -> 94.95, 80.00 -> 79.95, 104.10 -> 104.95).
 * Compare-at:    selling / (1 - discount), discount randomized 40-60% PER
 *                PRODUCT, rounded to a whole number ending in .00, and always
 *                strictly higher than the selling price.
 *
 * The discount is derived deterministically from the product code so that
 * (a) every product gets a slightly different percentage in range and
 * (b) results are reproducible and testable.
 */

'use strict';

const DISCOUNT_MIN = 0.40;
const DISCOUNT_MAX = 0.60;
const CHARM_FLOOR = 4.95; // smallest allowed charm price

/** Round to 2 decimals, avoiding binary float drift. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Charm-price snap: round to the nearest whole dollar, then to the closest
 * dollar ending in 4 or 9 (the two .95 boundaries inside each 10-dollar band),
 * and add .95. Numbers ending in 4 or 9 are exactly those ≡ 4 (mod 5), so the
 * nearest such dollar is round((n-4)/5)*5 + 4. Result always ends in 4.95/9.95.
 */
export function charmPrice(amount) {
  if (!(amount > 0)) throw new Error(`Invalid amount: ${amount}`);
  const n = Math.round(amount);            // nearest whole dollar
  let anchor = Math.round((n - 4) / 5) * 5 + 4; // nearest dollar ending in 4 or 9
  if (anchor < 4) anchor = 4;              // floor at 4.95
  return round2(anchor + 0.95);
}

/** Final selling price (spec 5.3 + strict charm rule): ends in 4.95 or 9.95. */
export function sellingPrice(sourcePrice) {
  if (!(sourcePrice > 0)) throw new Error(`Invalid sourcePrice: ${sourcePrice}`);
  return charmPrice(sourcePrice);
}

/** Deterministic FNV-1a hash -> unit float in [0, 1). */
function hashUnit(seed) {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/** Discount fraction in [0.40, 0.60], deterministic per seed (spec 5.4). */
export function discountFraction(seed) {
  return DISCOUNT_MIN + hashUnit(seed) * (DISCOUNT_MAX - DISCOUNT_MIN);
}

/**
 * Compare-at price (spec 5.4).
 * @param {number} selling  final selling price (ends in .95)
 * @param {number} discount fraction in [0.40, 0.60]
 * @returns {number} whole number ending in .00, strictly > selling
 */
export function compareAtPrice(selling, discount) {
  if (!(discount > 0 && discount < 1)) throw new Error(`Invalid discount: ${discount}`);
  let compareAt = Math.round(selling / (1 - discount));
  // Guard: must always be strictly higher than the selling price.
  if (compareAt <= selling) compareAt = Math.ceil(selling + 1);
  return round2(compareAt);
}

/**
 * Convenience: compute both prices for a product from its source price and a
 * stable seed (e.g. productCode) used to pick the per-product discount.
 */
export function computePrices(sourcePrice, seed) {
  const selling = sellingPrice(sourcePrice);
  const discount = discountFraction(seed);
  const compareAt = compareAtPrice(selling, discount);
  return { selling, compareAt, discountPct: round2(discount * 100) };
}

export { DISCOUNT_MIN, DISCOUNT_MAX, round2 };

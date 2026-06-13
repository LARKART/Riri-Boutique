/**
 * Pricing transforms (spec 5.3 selling price, 5.4 compare-at price).
 *
 * Selling price: floor to whole number, add .95.
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

/** Round to 2 decimals, avoiding binary float drift. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Selling price: floor(source) + .95  (spec 5.3). */
export function sellingPrice(sourcePrice) {
  if (!(sourcePrice > 0)) throw new Error(`Invalid sourcePrice: ${sourcePrice}`);
  return round2(Math.floor(sourcePrice) + 0.95);
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

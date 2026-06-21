/**
 * Pattern/print recognition (supplier sells many print dresses).
 *
 * When a source "Color" option value is actually a PATTERN (Floral, Polka Dot,
 * Striped, Animal Print, …) rather than a real color, we:
 *   - keep it as the storefront color/variant label (customers see "Floral"),
 *   - record the pattern for the Google feed's `pattern` attribute, and
 *   - infer the dress's base color for the feed's `color` attribute.
 *
 * This module recognizes patterns and infers a base color from text.
 */

'use strict';

import { stripStockSuffix } from './colors.js';

// Pattern phrase -> canonical token, most specific first.
const PATTERNS = [
  [/\bditsy\s+floral\b/i, 'Ditsy Floral'],
  [/\bfloral\b/i, 'Floral'],
  [/\bpolka\s*dots?\b/i, 'Polka Dot'],
  [/\bdots?\b/i, 'Polka Dot'],
  [/\bstrip(?:e|ed|es)\b/i, 'Striped'],
  [/\b(?:animal\s+print|leopard|cheetah|zebra|tiger|snake(?:skin)?(?:\s*print)?|python)\b/i, 'Animal Print'],
  [/\bgingham\b/i, 'Gingham'],
  [/\b(?:plaid|tartan)\b/i, 'Plaid'],
  [/\bcheck(?:ed|s)?\b/i, 'Checked'],
  [/\bpaisley\b/i, 'Paisley'],
  [/\btie[-\s]?dye\b/i, 'Tie Dye'],
  [/\bgeometric\b/i, 'Geometric'],
  [/\babstract\b/i, 'Abstract'],
  [/\btropical\b/i, 'Tropical'],
  [/\bwatercolou?r\b/i, 'Watercolor'],
  [/\bbotanical\b/i, 'Botanical'],
  [/\bhoundstooth\b/i, 'Houndstooth'],
  [/\bcamo(uflage)?\b/i, 'Camouflage'],
  [/\bprint(ed)?\b/i, 'Print'],
];

/** Canonical pattern names (allowlist), for reference/QA. */
export const PATTERN_TOKENS = [...new Set(PATTERNS.map(([, c]) => c))];

/** Return the canonical pattern for a value (e.g. "Floral"), or null if not a pattern. */
export function normalizePattern(value) {
  const t = stripStockSuffix(value);
  if (!t) return null;
  for (const [re, canon] of PATTERNS) if (re.test(t)) return canon;
  return null;
}

/** Is this value a recognized pattern/print? */
export function isPattern(value) {
  return normalizePattern(value) !== null;
}

// Base colors to look for when inferring a print's background color (priority order).
const BASE_COLORS = ['white', 'ivory', 'cream', 'black', 'navy', 'blue', 'sky blue', 'pink', 'blush',
  'red', 'burgundy', 'green', 'sage', 'olive', 'emerald', 'beige', 'tan', 'nude', 'yellow', 'gold',
  'orange', 'purple', 'lilac', 'lavender', 'brown', 'grey', 'gray', 'silver'];

/**
 * Infer a base color from free text (title/tags/description). Falls back to a
 * neutral default (White) when no color word is present — most prints sit on a
 * light base, and the value is surfaced as an inferred feed color for review.
 * @param {string} text
 * @param {string} [fallback='White']
 */
export function inferBaseColor(text, fallback = 'White') {
  const t = String(text || '');
  for (const c of BASE_COLORS) {
    if (new RegExp(`\\b${c.replace(/\s+/g, '\\s+')}\\b`, 'i').test(t)) {
      return c.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    }
  }
  return fallback;
}

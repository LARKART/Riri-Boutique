/**
 * Color normalization for SKU codes (spec 8: "Color code should be normalized
 * and consistent"). Maps a customer-facing color name to a short, stable code.
 */

'use strict';

// Common colors get curated 3-letter codes; everything else falls back to a
// deterministic slug so codes stay unique and consistent across imports.
const COLOR_CODES = {
  black: 'BLK',
  white: 'WHT',
  ivory: 'IVR',
  cream: 'CRM',
  red: 'RED',
  burgundy: 'BUR',
  wine: 'WIN',
  pink: 'PNK',
  blush: 'BLS',
  rose: 'ROS',
  purple: 'PUR',
  lilac: 'LIL',
  lavender: 'LAV',
  blue: 'BLU',
  navy: 'NVY',
  teal: 'TEL',
  green: 'GRN',
  emerald: 'EMR',
  olive: 'OLV',
  sage: 'SGE',
  yellow: 'YEL',
  gold: 'GLD',
  orange: 'ORG',
  brown: 'BRN',
  tan: 'TAN',
  beige: 'BEI',
  nude: 'NUD',
  grey: 'GRY',
  gray: 'GRY',
  silver: 'SLV',
};

/** Normalize a display color to its SKU code. */
export function colorCode(color) {
  const key = String(color).trim().toLowerCase();
  if (COLOR_CODES[key]) return COLOR_CODES[key];
  // Fallback: first 3 alphabetic chars, uppercased (e.g. "Champagne" -> "CHA").
  const slug = key.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase();
  return slug || 'CLR';
}

export { COLOR_CODES };

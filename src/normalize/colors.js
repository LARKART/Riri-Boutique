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

// --- Color allowlist (option values must be REAL colors, not patterns) --------
// Base color words (curated codes above) plus common named fashion colors. A
// value is accepted if, after stripping shade modifiers, every remaining word is
// a known color word. Non-colors (e.g. "Dots", "Floral", "Stripe") are rejected.
const NAMED_COLORS = new Set([
  ...Object.keys(COLOR_CODES),
  'champagne', 'taupe', 'mauve', 'coral', 'mint', 'mustard', 'rust', 'khaki', 'charcoal',
  'camel', 'chocolate', 'espresso', 'sand', 'stone', 'plum', 'periwinkle', 'turquoise',
  'aqua', 'fuchsia', 'magenta', 'maroon', 'denim', 'cobalt', 'indigo', 'slate', 'pewter',
  'bronze', 'copper', 'peach', 'apricot', 'lemon', 'lime', 'forest', 'hunter', 'terracotta',
  'cognac', 'ecru', 'oatmeal', 'sky', 'royal', 'mocha', 'caramel', 'honey', 'amber', 'ruby',
  'sapphire', 'jade', 'pistachio', 'seafoam', 'cerulean', 'azure', 'chartreuse', 'fawn',
  'ochre', 'sienna', 'wheat', 'pearl', 'graphite', 'gunmetal', 'multicolor', 'multi',
]);

// Shade/qualifier words that may precede a color word.
const COLOR_MODIFIERS = new Set([
  'light', 'dark', 'deep', 'pale', 'bright', 'medium', 'hot', 'dusty', 'muted', 'soft',
  'neon', 'rich', 'warm', 'cool', 'off', 'baby', 'dusky', 'vintage', 'classic', 'true',
  'heather', 'metallic', 'electric', 'burnt', 'dirty', 'powder',
]);

// Sentinel option value used when a product genuinely has no color dimension.
const COLOR_SENTINELS = new Set(['default']);

/**
 * Normalize a candidate color to a clean Title-Cased display value, or return
 * null if it is not a real color. Casing/whitespace only — words are preserved
 * so downstream lowercase matching (variant overrides, image linkage) still
 * lines up with the source.
 */
export function normalizeColorName(value) {
  const raw = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  if (COLOR_SENTINELS.has(raw.toLowerCase())) return 'Default';
  const tokens = raw.toLowerCase().split(/[\s/&-]+/).filter(Boolean);
  const meaningful = tokens.filter((t) => !COLOR_MODIFIERS.has(t));
  if (meaningful.length === 0) return null; // only modifiers -> not a color
  if (!meaningful.every((t) => NAMED_COLORS.has(t))) return null;
  return raw.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ');
}

/** Is the value an allowed color (or the "Default" sentinel)? */
export function isAllowedColor(value) {
  return normalizeColorName(value) !== null;
}

export { COLOR_CODES, NAMED_COLORS };

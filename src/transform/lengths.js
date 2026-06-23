/**
 * Canonical dress/garment length vocabulary (spec §5.1/§12).
 *
 * One source of truth shared by the input validator, the Apify mapper (length
 * inference from source text), the title builder (enforcement), and the
 * pre-publish QA gate (length-token check). Every dress title MUST carry one of
 * these tokens — a title without a length is rejected, never emitted.
 */

'use strict';

/** Canonical length tokens permitted in attributes.length and titles. */
export const LENGTH_TOKENS = ['Mini', 'Midi', 'Maxi', 'Knee Length', 'Tea Length', 'Floor Length', 'Ankle Length'];

const LENGTH_TOKEN_SET = new Set(LENGTH_TOKENS);

// Free-text patterns -> canonical token, most specific first.
const LENGTH_PATTERNS = [
  [/\bfloor[-\s]?length\b/i, 'Floor Length'],
  [/\bfull[-\s]?length\b/i, 'Floor Length'],
  [/\bfloor[-\s]?grazing\b/i, 'Floor Length'],
  [/\btea[-\s]?length\b/i, 'Tea Length'],
  [/\bknee[-\s]?length\b/i, 'Knee Length'],
  [/\bankle[-\s]?length\b/i, 'Ankle Length'],
  [/\bmaxi\b/i, 'Maxi'],
  [/\b(?:ball\s*)?gown\b/i, 'Maxi'],
  [/\bmidi\b/i, 'Midi'],
  [/\bmini\b/i, 'Mini'],
];

/** Is a value one of the canonical length tokens? */
export function isLengthToken(value) {
  return LENGTH_TOKEN_SET.has(String(value || '').trim());
}

/** Infer a canonical length token from free text (e.g. a source title), or null. */
export function detectLength(text) {
  const t = String(text || '');
  for (const [re, token] of LENGTH_PATTERNS) if (re.test(t)) return token;
  return null;
}

/** Does a built title contain any canonical length token (word-boundary match)? */
export function hasLengthToken(title) {
  const t = String(title || '');
  return LENGTH_TOKENS.some((token) => new RegExp(`\\b${token.replace(/\s+/g, '\\s+')}\\b`, 'i').test(t));
}

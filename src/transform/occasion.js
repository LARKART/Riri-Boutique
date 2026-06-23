/**
 * Collection occasion keyword (spec §5.1/§12 alignment).
 *
 * A routing collection's name implies an occasion/season keyword that belongs in
 * the product title (and SEO title) so listings rank for it:
 *   "Wedding Guest Dresses" -> "Wedding Guest"
 *   "Summer Dresses"        -> "Summer"
 *   "Dresses"               -> (none)
 *
 * The keyword is injected into the title's occasion slot (before the length
 * token) at build time, and the pre-publish QA gate fails any product whose
 * title is missing its collection keyword — unless a run opts out.
 */

'use strict';

import { LENGTH_TOKENS } from './lengths.js';

/** Derive the occasion/season keyword from a collection name, or null. */
export function collectionKeyword(collectionTitle) {
  let s = String(collectionTitle || '').trim();
  let prev;
  do { prev = s; s = s.replace(/\s*\b(dresses|dress|sets|set|collection|edit)\b\s*$/i, '').trim(); } while (s !== prev);
  return s || null;
}

/** Whole-word, case-insensitive presence test. */
export function titleHasKeyword(title, keyword) {
  if (!keyword) return true;
  const esc = String(keyword).replace(/[.*+?^${}()|[\]{}\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${esc}\\b`, 'i').test(String(title || ''));
}

// Anchor tokens we insert the keyword before: length tokens, then the garment
// noun. Garment-specific nouns come before the generic "Set" so insertion reads
// naturally ("Long Sleeve Summer Pants Set", not "Pants Summer Set").
const ANCHORS = [...LENGTH_TOKENS, 'Dress', 'Dresses', 'Pants', 'Trousers', 'Shorts',
  'Skirt', 'Romper', 'Jumpsuit', 'Top', 'Set', 'Sets'];

/**
 * Insert the keyword before the length token (or "Dress") in a title, keeping the
 * keyword-first structure. Idempotent: returns the title unchanged if it already
 * contains the keyword. Returns it unchanged if no anchor is found.
 */
export function insertKeywordBeforeLength(title, keyword) {
  const t = String(title || '');
  if (!keyword || titleHasKeyword(t, keyword)) return t;
  for (const anchor of ANCHORS) {
    const re = new RegExp(`\\b(${anchor.replace(/\s+/g, '\\s+')})\\b`, 'i');
    if (re.test(t)) return t.replace(re, `${keyword} $1`);
  }
  return t;
}

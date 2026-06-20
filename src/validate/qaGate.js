/**
 * Pre-publish QA gate (the real safety net).
 *
 * Validates a finished ProductDraft right before any write/publish and fails
 * LOUDLY if anything is wrong. Catches the exact defects seen in the field:
 * SKU/name mismatch, name carryover in copy, missing title length, non-color
 * option values, broken compare-at pricing, and missing taxonomy/feed fields.
 */

'use strict';

import { productCode } from '../transform/sku.js';
import { isAllowedColor } from '../normalize/colors.js';
import { hasLengthToken } from '../transform/lengths.js';
import { DRESS_CATEGORY_GID } from '../transform/taxonomy.js';
import { FEED_NAMESPACE } from '../transform/feed.js';

const REQUIRED_FEED_KEYS = ['gender', 'age_group', 'condition', 'custom_product'];

/** Strip HTML to plain text for name-substring checks. */
function plain(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Whole-word, case-insensitive presence test. */
function wordPresent(haystack, word) {
  if (!word) return false;
  const esc = String(word).replace(/[.*+?^${}()|[\]{}\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(String(haystack));
}

/**
 * Run all pre-publish checks on one draft.
 * @param {object} draft canonical ProductDraft
 * @param {{runNames?: string[]}} [opts] every product name in the batch (for
 *   cross-contamination detection)
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkProductQA(draft, opts = {}) {
  const errors = [];
  const name = draft?.name;
  if (!name) return { ok: false, errors: ['Product has no name.'] };
  const variants = draft.variants || [];

  // 1) Every SKU is derived from THIS product's own name.
  const expectedPrefix = `RIRI-${productCode(name)}-`;
  if (!variants.length) errors.push('Product has no variants.');
  for (const v of variants) {
    if (!String(v.sku || '').startsWith(expectedPrefix)) {
      errors.push(`SKU "${v.sku}" does not start with "${expectedPrefix}" (name "${name}").`);
      break; // one report is enough
    }
  }

  // 2) Copy uses the product's own name and NO other product's name.
  const fields = {
    description: plain(draft.descriptionHtml),
    'seo.title': String(draft.seo?.title || ''),
    'seo.description': String(draft.seo?.description || ''),
  };
  for (const [field, text] of Object.entries(fields)) {
    if (!wordPresent(text, name)) {
      errors.push(`${field} does not contain the product's own name "${name}".`);
    }
  }
  const others = (opts.runNames || []).filter((n) => n && n.toLowerCase() !== name.toLowerCase());
  for (const [field, text] of Object.entries(fields)) {
    const intruder = others.find((o) => wordPresent(text, o));
    if (intruder) errors.push(`${field} contains another product's name "${intruder}" (carryover).`);
  }

  // 3) Title carries a length token.
  if (!hasLengthToken(draft.title)) {
    errors.push(`Title "${draft.title}" is missing a length token (Midi/Maxi/etc.).`);
  }

  // 4) Every color option value is a real, allowed color.
  const colorOption = (draft.options || []).find((o) => /colou?r/i.test(o.name || ''));
  for (const c of colorOption?.values || []) {
    if (!isAllowedColor(c)) errors.push(`Color "${c}" is not an allowed color value.`);
  }

  // 5) compareAtPrice > price and ends in .00.
  for (const v of variants) {
    const price = Number(v.price);
    const cmp = Number(v.compareAtPrice);
    if (!(cmp > price)) errors.push(`Variant ${v.sku}: compareAtPrice ${v.compareAtPrice} is not > price ${v.price}.`);
    if (Math.round(cmp * 100) % 100 !== 0) errors.push(`Variant ${v.sku}: compareAtPrice ${v.compareAtPrice} does not end in .00.`);
  }

  // 6) Taxonomy + GMC feed metafields.
  if (draft.isDress) {
    if (draft.category?.id !== DRESS_CATEGORY_GID) {
      errors.push(`Category is "${draft.category?.id}", expected ${DRESS_CATEGORY_GID} for a dress.`);
    }
  } else if (!draft.category?.id) {
    errors.push('Category is not set.');
  }
  const feed = draft.feedMetafields || [];
  for (const key of REQUIRED_FEED_KEYS) {
    if (!feed.some((m) => m.namespace === FEED_NAMESPACE && m.key === key)) {
      errors.push(`Missing feed metafield ${FEED_NAMESPACE}.${key}.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Run the gate across many drafts, sharing the batch name set for
 * cross-contamination detection.
 * @param {object[]} drafts
 * @returns {Array<{draft: object, ok: boolean, errors: string[]}>}
 */
export function runQAGate(drafts) {
  const runNames = drafts.map((d) => d?.name).filter(Boolean);
  return drafts.map((draft) => ({ draft, ...checkProductQA(draft, { runNames }) }));
}

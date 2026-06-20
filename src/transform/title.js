/**
 * Title generation (spec 5.1, 12).
 *
 * Dress format:
 *   Women's [Neckline/Silhouette] [Occasion] [Length] Dress | [Name]
 * Non-dress: adapt the same keyword-first structure to the product type.
 *
 * Rules enforced here:
 *  - "Women's" always first; keyword-first; invented name only after the pipe.
 *  - No colors in the title (multi-color variants break title accuracy).
 *  - One occasion only (the input already carries a single occasion).
 *  - Attributes appear only when present (no padding).
 */

'use strict';

import { hasLengthToken } from './lengths.js';

/** Collapse whitespace and trim. */
function clean(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The colorless title core (everything before " | "), also used as image
 * alt text (spec 9.2).
 */
export function titleCore({ isDress, productType, attributes = {} }) {
  const a = attributes;
  const parts = ["Women's"];

  if (isDress) {
    // [Neckline/Silhouette] occupies one slot; prefer neckline.
    const shape = a.neckline || a.silhouette;
    if (shape) parts.push(shape);
    if (a.occasion) parts.push(a.occasion);
    if (a.length) parts.push(a.length);
    parts.push('Dress');
  } else {
    // Adaptive: stack only present descriptors, then the product type noun.
    for (const key of ['material', 'silhouette', 'neckline', 'sleeve', 'length', 'occasion']) {
      if (a[key]) parts.push(a[key]);
    }
    parts.push(productType);
  }

  return clean(parts.join(' '));
}

/** Full product title including the invented name after the pipe. */
export function buildTitle(draft) {
  const core = titleCore(draft);
  // Every dress title must carry a length token (spec §5.1/§12); fail loudly
  // rather than emit a length-less title.
  if (draft.isDress && !hasLengthToken(core)) {
    throw new Error(
      `Dress title is missing a length token (${'e.g. Midi/Maxi'}): "${core}". ` +
      'Provide or infer attributes.length before building the title.'
    );
  }
  const name = draft.name ? clean(draft.name) : '';
  return name ? `${core} | ${name}` : core;
}

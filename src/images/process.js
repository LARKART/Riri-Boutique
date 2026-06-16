/**
 * Image processing & variant-color mapping (spec 9, 14.2; lifecycle Stage 7).
 *
 * 1. SOURCE & ALT TEXT  — ingest supplier image URLs from the input contract;
 *    alt text = the colorless title core (spec 9.2).
 * 2. IMAGE QA FILTER    — gate that rejects watermarks, promo overlay text,
 *    sale badges, store logos, and competitor branding (spec 9.1, 14.2).
 *    Real visual detection is a pluggable async detector; a filename/URL
 *    heuristic ships as the default first line of defence.
 * 3. VARIANT COLOR MAPPING — group approved images by designated color, map to
 *    the matching color variants, and PRESERVE the original gallery order
 *    (spec 9.1). Main image = the one flagged main, else the first image of the
 *    first (strongest/default) color.
 */

'use strict';

import { titleCore } from '../transform/title.js';

// URL/filename tokens that signal a prohibited image. Heuristic only — a real
// vision detector should be added via the `detectors` option for production QA.
const REJECT_TOKENS = [
  'watermark', 'wm-', 'sale', 'badge', 'promo', 'discount', 'clearance',
  'percent-off', '-off-', '_off', 'overlay', 'logo', 'sticker',
];

// Competitor brand names to reject if they appear in the image URL/filename.
// Populate with the actual competitors used as structural references (spec 17).
const COMPETITOR_BRANDS = [];

/** Default heuristic detector: inspects the image URL/filename for bad tokens. */
export function filenameHeuristicDetector(image) {
  const src = String(image.src || '').toLowerCase();
  const hit = REJECT_TOKENS.find((t) => src.includes(t));
  if (hit) return `URL/filename suggests a prohibited overlay/badge ("${hit}")`;
  const brand = COMPETITOR_BRANDS.map((b) => b.toLowerCase()).find((b) => b && src.includes(b));
  if (brand) return `URL/filename contains competitor branding ("${brand}")`;
  return null;
}

/**
 * Placeholder for real visual QA (watermark / overlay-text / badge detection).
 * Not enabled by default — wire in a CV/model-based detector here. Returning a
 * non-null string rejects the image with that reason.
 */
export async function visualOverlayDetectorPlaceholder(/* image */) {
  // TODO: integrate image-analysis (e.g. OCR for overlay text, logo detection).
  return null; // inconclusive -> does not reject on its own
}

const DEFAULT_DETECTORS = [filenameHeuristicDetector];

/** Run all detectors against one image. @returns {{approved, reasons:string[]}} */
export async function qaImage(image, detectors = DEFAULT_DETECTORS) {
  const reasons = [];
  for (const detect of detectors) {
    const reason = await detect(image);
    if (reason) reasons.push(reason);
  }
  return { approved: reasons.length === 0, reasons };
}

/**
 * Process a draft's images: QA-filter, order, and map to color variants.
 * @param {object} draft canonical draft (needs colors, images, attributes, isDress, productType)
 * @param {{detectors?: Function[]}} [opts]
 * @returns {Promise<{
 *   altText: string,
 *   media: Array<{src,altText,color,position,main}>,
 *   imagesByColor: Record<string,string[]>,
 *   variantImageByColor: Record<string,string|null>,
 *   mainSrc: string|null,
 *   rejected: Array<{src,reasons:string[]}>,
 *   warnings: string[]
 * }>}
 */
export async function processImages(draft, opts = {}) {
  const detectors = opts.detectors || DEFAULT_DETECTORS;
  const altText = titleCore(draft);
  const warnings = [];
  const images = Array.isArray(draft.images) ? draft.images : [];

  // Canonical color casing: lowercased key -> display value from draft.colors.
  const colorCanon = new Map((draft.colors || []).map((c) => [String(c).trim().toLowerCase(), c]));

  // Preserve gallery order: stable sort by position (when present), then input order.
  const ordered = images
    .map((img, idx) => ({ img, idx }))
    .sort((a, b) => {
      const pa = a.img.position ?? Infinity;
      const pb = b.img.position ?? Infinity;
      return pa === pb ? a.idx - b.idx : pa - pb;
    });

  const approved = [];
  const rejected = [];
  for (const { img } of ordered) {
    const { approved: ok, reasons } = await qaImage(img, detectors);
    if (ok) approved.push(img);
    else rejected.push({ src: img.src, reasons });
  }

  // Group approved images by canonical color, preserving order.
  const imagesByColor = {};
  for (const img of approved) {
    if (img.color == null) continue;
    const canon = colorCanon.get(String(img.color).trim().toLowerCase());
    if (!canon) continue; // already errored by the input validator; skip defensively
    (imagesByColor[canon] ||= []).push(img.src);
  }

  // Main image: explicitly flagged, else first image of the first declared color,
  // else the first approved image overall (spec 9.1).
  const flaggedMain = approved.find((i) => i.main === true);
  const firstColor = (draft.colors || [])[0];
  const mainSrc =
    flaggedMain?.src ||
    (firstColor && imagesByColor[firstColor]?.[0]) ||
    approved[0]?.src ||
    null;

  // Default image per color variant (size does not change the image).
  const variantImageByColor = {};
  for (const color of draft.colors || []) {
    const list = imagesByColor[color];
    variantImageByColor[color] = list?.[0] || null;
    if (!list || list.length === 0) {
      warnings.push(`Color "${color}" has no approved image (spec 14.2 requires every color variant to have an image).`);
    }
  }

  if (approved.length === 0 && images.length > 0) {
    warnings.push('All images were rejected by QA; product has no usable media.');
  }
  if (images.length === 0) {
    warnings.push('No images provided; variant image mapping is empty.');
  }

  // Ordered media list with alt text + main flag.
  const media = approved.map((img) => ({
    src: img.src,
    altText,
    color: img.color ?? null,
    position: img.position ?? null,
    main: img.src === mainSrc,
  }));

  return { altText, media, imagesByColor, variantImageByColor, mainSrc, rejected, warnings };
}

export { REJECT_TOKENS, COMPETITOR_BRANDS, DEFAULT_DETECTORS };

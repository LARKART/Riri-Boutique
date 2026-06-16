/**
 * Stage 0 transformer: Apify raw Shopify product -> our product-input contract.
 *
 * Maps STRUCTURE only (productType, colors, sizes, price) per spec §4/§17.
 * Deliberately does NOT carry over the competitor's title/vendor as the product
 * name (spec §5.2 — names are invented by Stage 6) and does NOT place scraped
 * images into the approved `images[]` unless `trustImages: true` is passed
 * (spec §9.3/§17 — images must be licensed/owned/approved). By default scraped
 * images are returned separately as `unverifiedImages` for manual approval.
 *
 * Returns { input, unverifiedImages, notes } where `input` is schema-valid.
 */

'use strict';

const LENGTHS = [['maxi', 'Maxi'], ['midi', 'Midi'], ['mini', 'Mini']];

function normalizeList(values) {
  const seen = new Set();
  const out = [];
  for (const v of values || []) {
    const s = String(v).trim();
    const k = s.toLowerCase();
    if (s && !seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
}

function detectLength(title) {
  const t = String(title || '').toLowerCase();
  for (const [needle, label] of LENGTHS) if (t.includes(needle)) return label;
  return null;
}

/**
 * @param {object} raw an Apify item ~ Shopify product JSON
 * @param {object} [opts]
 * @param {string} [opts.sourceCurrency='CAD'] currency of scraped prices (verify! spec §13)
 * @param {string} [opts.group] collection theme; defaults to productType
 * @param {string} [opts.referenceUrl] structural reference URL
 * @param {boolean} [opts.trustImages=false] only set true when image rights are confirmed
 * @returns {{input: object, unverifiedImages: Array, notes: string[]}}
 */
export function mapApifyToInput(raw, opts = {}) {
  const { sourceCurrency = 'CAD', group, referenceUrl, trustImages = false } = opts;
  const notes = [];

  const productType = raw.product_type || raw.productType || raw.type || 'Product';
  const isDress = /dress/i.test(productType) || /dress/i.test(raw.title || '');

  // Options: match by name (Color / Size); fall back to deriving from variants.
  const options = raw.options || [];
  const byName = (re) => options.find((o) => re.test(o?.name || ''));
  const colorOpt = byName(/colou?r/i);
  const sizeOpt = byName(/size/i);

  let colors = normalizeList(colorOpt?.values);
  let sizes = normalizeList(sizeOpt?.values);
  if (colors.length === 0) { colors = ['Default']; notes.push('No Color option found; defaulted to "Default".'); }
  if (sizes.length === 0) { sizes = ['One Size']; notes.push('No Size option found; defaulted to "One Size".'); }

  // Price: minimum variant price.
  const prices = (raw.variants || [])
    .map((v) => parseFloat(v.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  const sourcePrice = prices.length ? Math.min(...prices) : NaN;
  if (!Number.isFinite(sourcePrice)) {
    throw new Error('mapApifyToInput: could not derive a positive sourcePrice from scraped variants.');
  }

  const input = {
    sourceCurrency,
    sourcePrice,
    productType,
    isDress,
    group: group || productType,
    colors,
    sizes,
  };
  if (sourceCurrency !== 'CAD') notes.push(`sourceCurrency is ${sourceCurrency}; verify FX before pricing (spec §13).`);

  const length = detectLength(raw.title);
  if (length) input.attributes = { length };

  const url = referenceUrl || raw.url || raw.handle;
  if (url && /^https?:\/\//.test(url)) input.referenceUrl = url;

  // Images — quarantined by default (spec §9.3/§17).
  const scraped = (raw.images || []).map((im, i) => ({
    src: im.src || im.url || im,
    position: im.position ?? i + 1,
  })).filter((im) => typeof im.src === 'string' && /^https?:\/\//.test(im.src));

  let unverifiedImages = [];
  if (trustImages && scraped.length) {
    // Caller asserts rights: map into approved images (color via variant linkage best-effort).
    const variantColor = new Map();
    for (const v of raw.variants || []) {
      const c = v.option1 && colorOpt && options.indexOf(colorOpt) === 0 ? v.option1
        : v.option2 && colorOpt && options.indexOf(colorOpt) === 1 ? v.option2 : null;
      if (c) variantColor.set(v.id, c);
    }
    input.images = (raw.images || []).map((im, i) => {
      const vid = (im.variant_ids || [])[0];
      const color = vid != null ? variantColor.get(vid) || null : null;
      return { src: im.src || im.url, position: im.position ?? i + 1, ...(color ? { color } : {}), ...(i === 0 ? { main: true } : {}) };
    }).filter((im) => /^https?:\/\//.test(im.src || ''));
    notes.push('trustImages=true: scraped images placed into approved images[]. Ensure rights are confirmed (spec §9.3/§17).');
  } else {
    unverifiedImages = scraped;
    if (scraped.length) notes.push(`${scraped.length} scraped image(s) QUARANTINED (not added to images[]). Re-run with trustImages:true only if licensed/owned/approved (spec §9.3/§17).`);
  }

  return { input, unverifiedImages, notes };
}

/**
 * Input contract validator (spec 14.4: validate before execution).
 *
 * Runs BEFORE any transformation module. Confirms a hand-authored product JSON
 * matches schemas/product-input.schema.json AND the semantic rules in the spec.
 *
 * Returns { valid, errors, warnings }:
 *   - errors   block the pipeline (structural / contract violations)
 *   - warnings allow it but surface spec risks (e.g. missing images, FX needed)
 */

'use strict';

import { LENGTH_TOKENS, isLengthToken } from '../transform/lengths.js';

const CURRENCIES = new Set(['CAD', 'USD']);
const STORE_CURRENCY = 'CAD'; // confirmed via get-shop-info
const KNOWN_KEYS = new Set([
  'sourceCurrency', 'sourcePrice', 'productType', 'isDress', 'isSet', 'isSwim',
  'swimCategoryId', 'name', 'productCode', 'group', 'attributes', 'colors', 'sizes',
  'variantOverrides', 'images', 'referenceUrl', 'descriptionInput', 'pattern', 'feedColor',
]);
const KNOWN_ATTR_KEYS = new Set(['neckline', 'silhouette', 'occasion', 'length', 'sleeve', 'material']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function dedupeKey(v) {
  return String(v).trim().toLowerCase();
}

/** Validate a single product-input object. */
export function validateProductInput(input) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a JSON object.'], warnings: [] };
  }

  // --- required fields ---
  for (const key of ['sourceCurrency', 'sourcePrice', 'productType', 'isDress', 'group', 'colors', 'sizes']) {
    if (!(key in input)) E(`Missing required field: "${key}".`);
  }

  // --- unknown keys ---
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) W(`Unknown top-level field "${key}" will be ignored.`);
  }

  // --- currency / price (spec 13, 5.3) ---
  if ('sourceCurrency' in input) {
    if (!CURRENCIES.has(input.sourceCurrency)) {
      E(`sourceCurrency must be one of ${[...CURRENCIES].join(', ')}; got "${input.sourceCurrency}".`);
    } else if (input.sourceCurrency !== STORE_CURRENCY) {
      W(`sourceCurrency is ${input.sourceCurrency} (store is ${STORE_CURRENCY}); FX conversion applies before .95 rounding — verify the configured rate (spec 13).`);
    }
  }
  if ('sourcePrice' in input && !(typeof input.sourcePrice === 'number' && input.sourcePrice > 0)) {
    E(`sourcePrice must be a number > 0; got ${JSON.stringify(input.sourcePrice)}.`);
  }

  // --- simple typed fields ---
  if ('productType' in input && !isNonEmptyString(input.productType)) E('productType must be a non-empty string.');
  if ('isDress' in input && typeof input.isDress !== 'boolean') E('isDress must be a boolean.');
  if ('group' in input && !isNonEmptyString(input.group)) E('group must be a non-empty string (collection theme).');
  if (input.isDress === true && isNonEmptyString(input.productType) && input.productType.trim().toLowerCase() !== 'dress') {
    W(`isDress is true but productType is "${input.productType}" (expected "Dress").`);
  }

  // --- naming (spec 5.2, 8) ---
  if (!isNonEmptyString(input.name) && !isNonEmptyString(input.productCode)) {
    W('No name or productCode provided; an invented name will be generated and used to derive the SKU PRODUCTCODE.');
  }
  if ('productCode' in input && isNonEmptyString(input.productCode) &&
      input.productCode.toUpperCase().replace(/[^A-Z0-9]/g, '').length === 0) {
    E('productCode contains no alphanumeric characters usable for a SKU.');
  }

  // --- colors / sizes ---
  const colorSet = new Set();
  const sizeSet = new Set();
  for (const [field, store] of [['colors', colorSet], ['sizes', sizeSet]]) {
    if (!(field in input)) continue;
    const arr = input[field];
    if (!Array.isArray(arr) || arr.length === 0) {
      E(`${field} must be a non-empty array.`);
      continue;
    }
    for (const v of arr) {
      if (!isNonEmptyString(v)) { E(`${field} contains a non-string or empty value: ${JSON.stringify(v)}.`); continue; }
      const k = dedupeKey(v);
      if (store.has(k)) E(`${field} has a duplicate value (case-insensitive): "${v}".`);
      store.add(k);
    }
  }

  // --- attributes (spec 5.1) ---
  if ('attributes' in input) {
    const a = input.attributes;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      E('attributes must be an object.');
    } else {
      for (const key of Object.keys(a)) {
        if (!KNOWN_ATTR_KEYS.has(key)) W(`Unknown attribute "${key}" will be ignored.`);
      }
      if (a.length != null && !isLengthToken(a.length)) {
        E(`attributes.length must be one of ${LENGTH_TOKENS.join(', ')}; got "${a.length}".`);
      }
      if (isNonEmptyString(a.occasion) && /,|&|\band\b|\//i.test(a.occasion)) {
        W(`attributes.occasion "${a.occasion}" looks like multiple occasions; spec 5.1 requires exactly one.`);
      }
      if (input.isDress === true && !isNonEmptyString(a.occasion)) {
        W('Dress has no occasion attribute; the title will omit the occasion keyword.');
      }
      if (input.isDress === true && a.length == null) {
        W('Dress has no length attribute; a length must be inferred or the product will fail title building (spec §5.1/§12).');
      }
    }
  } else if (input.isDress === true) {
    W('Dress has no attributes block; title may be sparse.');
  }

  // --- variant overrides ---
  if ('variantOverrides' in input) {
    if (!Array.isArray(input.variantOverrides)) {
      E('variantOverrides must be an array.');
    } else {
      input.variantOverrides.forEach((o, i) => {
        if (o === null || typeof o !== 'object') { E(`variantOverrides[${i}] must be an object.`); return; }
        if (!colorSet.has(dedupeKey(o.color))) E(`variantOverrides[${i}].color "${o.color}" is not in colors.`);
        if (!sizeSet.has(dedupeKey(o.size))) E(`variantOverrides[${i}].size "${o.size}" is not in sizes.`);
        if (!(typeof o.sourcePrice === 'number' && o.sourcePrice > 0)) E(`variantOverrides[${i}].sourcePrice must be a number > 0.`);
      });
    }
  }

  // --- images (spec 9, 14.2) ---
  if ('images' in input) {
    if (!Array.isArray(input.images)) {
      E('images must be an array.');
    } else {
      let mainCount = 0;
      const coveredColors = new Set();
      input.images.forEach((img, i) => {
        if (img === null || typeof img !== 'object') { E(`images[${i}] must be an object.`); return; }
        if (!isNonEmptyString(img.src)) { E(`images[${i}].src is required.`); }
        else {
          try {
            const u = new URL(img.src);
            if (u.protocol !== 'https:') W(`images[${i}].src is not https (${u.protocol}).`);
          } catch { E(`images[${i}].src is not a valid URL: "${img.src}".`); }
        }
        if (img.color != null) {
          if (!colorSet.has(dedupeKey(img.color))) E(`images[${i}].color "${img.color}" is not in colors.`);
          else coveredColors.add(dedupeKey(img.color));
        }
        if (img.position != null && !(Number.isInteger(img.position) && img.position >= 1)) {
          E(`images[${i}].position must be an integer >= 1.`);
        }
        if (img.main === true) mainCount++;
      });
      if (mainCount > 1) E(`Only one image may be marked main; found ${mainCount}.`);
      if (input.images.length > 0 && mainCount === 0) W('No image marked main; the strongest/default color image should be the main image (spec 9.1).');
      // spec 14.2: every color variant must have a matching image.
      for (const c of colorSet) {
        if (!coveredColors.has(c)) W(`Color "${c}" has no mapped image (spec 14.2 requires every color variant to have an image).`);
      }
    }
  } else {
    W('No images provided; variant image mapping/QA (spec 9, 14.2) cannot run for this product.');
  }

  // --- URLs ---
  if ('referenceUrl' in input && isNonEmptyString(input.referenceUrl)) {
    try { new URL(input.referenceUrl); } catch { E(`referenceUrl is not a valid URL: "${input.referenceUrl}".`); }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Google Merchant Center / Performance Max feed fields (spec 6.3; Stage 5).
 *
 * Written as metafields in the `mm-google-shopping` namespace, the convention
 * the Google & YouTube sales channel reads. NOTE: `color` is intentionally NOT
 * a metafield here — the spec requires color to come from the variant option
 * (spec 6.3), and the feed app derives the Google `color` attribute from the
 * colour product option automatically (verified: option named "Colour" still
 * maps to Google "color"). The option carries Canadian spelling "Colour".
 *
 * identifier_exists=no is represented as custom_product=true (the namespace's
 * way of saying "this product has no GTIN/barcode").
 */

'use strict';

const NS = 'mm-google-shopping';

/**
 * Build product-level feed metafields.
 * @param {{pattern?: string, color?: string}} [opts]
 *   pattern — when the product's color option is a print (e.g. "Floral"), the
 *     pattern is sent in the GMC `pattern` attribute.
 *   color — the dress's base color for the GMC `color` attribute. Normally color
 *     is derived from the "Colour" product option; for pattern products that
 *     option is the print, so we override the feed color with the base color.
 * @returns {Array<{namespace,key,type,value}>} metafield inputs for productSet
 */
export function buildFeedMetafields(opts = {}) {
  const fields = [
    { namespace: NS, key: 'gender', type: 'single_line_text_field', value: 'female' },
    { namespace: NS, key: 'age_group', type: 'single_line_text_field', value: 'adult' },
    { namespace: NS, key: 'condition', type: 'single_line_text_field', value: 'new' },
    // identifier_exists = no  ->  custom_product = true
    { namespace: NS, key: 'custom_product', type: 'boolean', value: 'true' },
  ];
  if (opts.pattern) fields.push({ namespace: NS, key: 'pattern', type: 'single_line_text_field', value: opts.pattern });
  if (opts.color) fields.push({ namespace: NS, key: 'color', type: 'single_line_text_field', value: opts.color });
  return fields;
}

export { NS as FEED_NAMESPACE };

/**
 * Google Merchant Center / Performance Max feed fields (spec 6.3; Stage 5).
 *
 * Written as metafields in the `mm-google-shopping` namespace, the convention
 * the Google & YouTube sales channel reads. NOTE: `color` is intentionally NOT
 * a metafield here — the spec requires color to come from the variant option
 * (spec 6.3), and the Google channel derives the feed color from the "Color"
 * product option automatically. So: ensure the option is literally named "Color".
 *
 * identifier_exists=no is represented as custom_product=true (the namespace's
 * way of saying "this product has no GTIN/barcode").
 */

'use strict';

const NS = 'mm-google-shopping';

/**
 * Build product-level feed metafields.
 * @returns {Array<{namespace,key,type,value}>} metafield inputs for productSet
 */
export function buildFeedMetafields() {
  return [
    { namespace: NS, key: 'gender', type: 'single_line_text_field', value: 'female' },
    { namespace: NS, key: 'age_group', type: 'single_line_text_field', value: 'adult' },
    { namespace: NS, key: 'condition', type: 'single_line_text_field', value: 'new' },
    // identifier_exists = no  ->  custom_product = true
    { namespace: NS, key: 'custom_product', type: 'boolean', value: 'true' },
  ];
}

export { NS as FEED_NAMESPACE };

/**
 * SKU generation (spec 8): RIRI-[PRODUCTCODE]-[COLORCODE]-[SIZE]
 * Every variant gets a unique SKU; color codes are normalized; size codes
 * match the customer-facing size option.
 */

'use strict';

import { colorCode } from '../normalize/colors.js';

/** Derive a PRODUCTCODE from an explicit code or the invented product name. */
export function productCode(nameOrCode) {
  return String(nameOrCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Normalize a customer-facing size into its SKU segment (e.g. "X-Large" -> "XL"). */
export function sizeCode(size) {
  return String(size).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Build the SKU for one color+size variant. */
export function buildSku(code, color, size) {
  return `RIRI-${productCode(code)}-${colorCode(color)}-${sizeCode(size)}`;
}

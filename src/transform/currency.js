/**
 * Currency conversion (spec §13). Source prices may be in a different currency
 * than the store (CAD). Convert (and apply markup) BEFORE the .95 rounding in
 * pricing.js. Rates are configured, never guessed: USD->CAD via FX_USD_CAD,
 * optional markup via PRICE_MARKUP (e.g. 0.15 for +15%).
 */

'use strict';

export const STORE_CURRENCY = 'CAD';

/** Build an FX config from the environment. */
export function buildFxFromEnv(env = process.env) {
  return {
    storeCurrency: STORE_CURRENCY,
    markup: Number(env.PRICE_MARKUP || 0) || 0,
    rates: { USD: Number(env.FX_USD_CAD || 0) || 0 },
  };
}

/**
 * Convert an amount in `from` currency to the store currency, applying markup.
 * @throws if a non-store currency has no configured rate (fail loud, not wrong).
 */
export function convertPrice(amount, from, fx = {}) {
  const store = fx.storeCurrency || STORE_CURRENCY;
  const f = String(from || store).toUpperCase();
  const markup = fx.markup || 0;
  let base;
  if (f === store) {
    base = amount;
  } else {
    const rate = (fx.rates || {})[f];
    if (!(rate > 0)) {
      throw new Error(`FX rate missing for ${f}->${store}; set FX_${f}_${store} (e.g. FX_USD_CAD).`);
    }
    base = amount * rate;
  }
  return base * (1 + markup);
}

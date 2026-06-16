/**
 * Minimal Shopify Admin API GraphQL client (custom-app shpat_ token auth).
 * Reads credentials from the environment; no secrets in source.
 */

'use strict';

const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

/**
 * Execute a GraphQL operation against the Admin API.
 * @returns {Promise<object>} the `data` payload
 * @throws on transport, auth, or GraphQL errors
 */
export async function shopifyGraphQL(query, variables = {}) {
  if (!DOMAIN) throw new Error('SHOPIFY_STORE_DOMAIN is not set.');
  if (!TOKEN) throw new Error('SHOPIFY_ADMIN_TOKEN is not set.');

  const endpoint = `https://${DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new Error(`Shopify network error: ${err.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Shopify auth failed (HTTP ${res.status}). Check SHOPIFY_ADMIN_TOKEN.`);
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Shopify returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  if (body.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

export { DOMAIN, API_VERSION };

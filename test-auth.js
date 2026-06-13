#!/usr/bin/env node
/**
 * test-auth.js — Isolated Shopify Admin API connection + auth test.
 *
 * What it does:
 *   1. Runs a basic GraphQL query ({ shop { name } }) to confirm the
 *      credentials authenticate against the Admin API.
 *   2. Reads the access scopes actually granted to the token and checks
 *      them against the scopes this project requires.
 *
 * Auth model (important):
 *   The Admin API authenticates with an ACCESS TOKEN (shpat_...) sent in the
 *   X-Shopify-Access-Token header. The OAuth Client ID / Client Secret
 *   (shpss_...) are install-time credentials and are NOT used to call the API
 *   directly, so this script intentionally does not reference them.
 *
 * Usage (Node 20.6+, zero dependencies):
 *   1. cp .env.example .env   and fill in SHOPIFY_ADMIN_TOKEN
 *   2. node --env-file=.env test-auth.js
 *
 * (On older Node, export the vars manually or `npm i -D dotenv` and
 *  add `require('dotenv').config()`.)
 */

'use strict';

const REQUIRED_SCOPES = [
  'write_products',
  'read_products',
  'write_publications',
  'read_publications',
  'write_assigned_fulfillment_orders',
  'read_assigned_fulfillment_orders',
];

const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!DOMAIN) fail('SHOPIFY_STORE_DOMAIN is not set. Copy .env.example to .env and fill it in.');
if (!TOKEN) fail('SHOPIFY_ADMIN_TOKEN is not set. See .env.example for how to obtain it.');
if (!TOKEN.startsWith('shpat_')) {
  console.warn(
    '⚠️  SHOPIFY_ADMIN_TOKEN does not start with "shpat_". The Admin API needs an ' +
    'access token, not the OAuth client secret (shpss_). Continuing anyway...\n'
  );
}

const ENDPOINT = `https://${DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

const QUERY = `
  query ConnectionTest {
    shop {
      name
      myshopifyDomain
      primaryDomain { url }
      plan { displayName }
    }
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

async function main() {
  console.log(`→ Testing ${ENDPOINT}\n`);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN,
      },
      body: JSON.stringify({ query: QUERY }),
    });
  } catch (err) {
    fail(`Network error reaching Shopify: ${err.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    fail(`Auth failed (HTTP ${res.status}). The token is invalid or lacks access. ` +
         `Double-check SHOPIFY_ADMIN_TOKEN and that the app is installed on the store.`);
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`Unexpected non-JSON response (HTTP ${res.status}):\n${text.slice(0, 500)}`);
  }

  if (body.errors) {
    fail(`GraphQL returned errors:\n${JSON.stringify(body.errors, null, 2)}`);
  }

  const shop = body.data?.shop;
  if (!shop) fail(`No shop data returned:\n${JSON.stringify(body, null, 2)}`);

  console.log('✅ Connection + authentication OK\n');
  console.log(`   Shop name : ${shop.name}`);
  console.log(`   Domain    : ${shop.myshopifyDomain}`);
  console.log(`   Storefront: ${shop.primaryDomain?.url}`);
  console.log(`   Plan      : ${shop.plan?.displayName}\n`);

  // Scope check
  const granted = new Set(
    (body.data?.currentAppInstallation?.accessScopes || []).map((s) => s.handle)
  );
  console.log(`→ Verifying ${REQUIRED_SCOPES.length} required scopes:\n`);

  const missing = [];
  for (const scope of REQUIRED_SCOPES) {
    const ok = granted.has(scope);
    console.log(`   ${ok ? '✅' : '❌'} ${scope}`);
    if (!ok) missing.push(scope);
  }

  console.log('');
  if (missing.length) {
    fail(`Missing scopes: ${missing.join(', ')}. ` +
         `Add them to the app's configuration and reinstall/regenerate the token.`);
  }

  console.log('✅ All required scopes are granted. You are good to go.\n');
}

main();

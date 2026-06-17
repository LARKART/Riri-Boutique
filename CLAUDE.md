# CLAUDE.md — Riri Boutique Automation Engine

Repo-level operating guide for the Shopify product-listing automation pipeline.
Treat this as the standing playbook for working in this repository.

## Overview

A staged pipeline that ingests product data, applies standardized transforms
(pricing, SKUs, titles, taxonomy, feed fields), generates original copy via the
Claude API, maps approved images to variants, and creates feed-safe Shopify
products via the Admin GraphQL `productSet` mutation — with a store-identity
guard, dry-run validation, and rollback.

- Node ≥ 20.6 (uses native `--env-file`), ESM modules.
- Store currency: **CAD**. Store: **Riri Boutique** (`zd7csp-i7.myshopify.com`).
- Auth: custom-app Admin API token (`shpat_`). Content: `claude-opus-4-8`.

## Environment & secrets

Secrets live in a **gitignored `.env`** (never commit). Template: `.env.example`.

| Var | Purpose |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | myshopify domain |
| `SHOPIFY_ADMIN_TOKEN` | Admin API token (`shpat_`) |
| `SHOPIFY_API_VERSION` | e.g. `2025-01` |
| `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` | identity-guard expected store |
| `ANTHROPIC_API_KEY` | Claude content module |
| `APIFY_API_TOKEN`, `APIFY_SHOPIFY_ACTOR_ID` | Stage 0 scraper |

Rules: never print secret values; edit `.env` in an editor, not the terminal;
rotate any key that gets exposed.

## Project structure

```
schemas/product-input.schema.json   # hand-authored input contract
examples/serane.json                # sample product
test-auth.js                        # Stage 1  auth + scope check
src/
  scrape/apify.js                   # Stage 0  Apify scraper (structure only)
  transform/
    apifyToInput.js                 # Stage 0  raw scrape -> input contract
    pricing.js                      # .95 selling / .00 compare-at
    sku.js                          # RIRI-CODE-COLOR-SIZE
    title.js                        # keyword-first title + colorless alt core
    taxonomy.js                     # dress -> aa-1-4 / dynamic lookup
    feed.js                         # GMC mm-google-shopping metafields
  normalize/{colors,variants}.js    # color codes + variant matrix
  content/generate.js               # Claude content (name, description, SEO)
  images/process.js                 # image QA filter + variant mapping
  validate/input.js                 # input contract validator (errors/warnings)
  shopify/
    client.js                       # Admin GraphQL client
    identityGuard.js                # store-data protection guard
    payload-builder.js              # ProductSetInput builder
    execute.js                      # productSet (guarded)
    collections.js                  # create + assign (BEST_SELLING)
    publish.js                      # publishablePublish (Online Store + Google)
    rollback.js                     # productDelete
  pipeline.js                       # orchestrator
scripts/                            # CLI entry points (see Commands)
logs/                               # gitignored run logs (created product IDs)
```

## Pipeline orchestrator (`src/pipeline.js`)

- `buildProductDraft(input, deps?)` — Stages 2–7; offline-capable with injected
  `deps.generate` / `deps.gql`. Returns the canonical ProductDraft (no writes).
- `finalizeProduct(productId, draft, { publish })` — Stage 11 collection
  assign + optional Stage 12 publish (publish off by default).
- `runProduct(input, { status, publish, deps })` — build → execute → finalize.
- `runPipelineFromUrl(url, { scrape, map, deps, execute, limit })` — Stage 0
  scrape → ingest. Writes off unless `execute:true`. Scraped images are
  quarantined unless `map.trustImages:true`.

## Commands

| Command | What it does | Writes? |
|---|---|---|
| `npm run test:auth` | Verify Admin token + 6 required scopes | read-only |
| `npm run verify:transforms` | Check pricing/SKU/title vs spec examples | none |
| `npm run validate:input <file.json>` | Validate a product input against the contract | none |
| `npm run demo:images` | Offline image QA + variant mapping demo | none |
| `npm run demo:apify` | Offline Stage 0 transformer/scraper demo (mocked) | none |
| `npm run dry-run` | Build payload + local pre-flight QA (no execution) | none |
| `node --env-file=.env scripts/pilot-run.js [input.json]` | Create ONE DRAFT product end-to-end | **WRITE** |
| `node --env-file=.env scripts/rollback.js <product-gid>` | Delete a product | **WRITE** |

Pilot/rollback need `.env` loaded (`--env-file=.env`).

## Guardrails (do not bypass)

- **Identity guard:** every write asserts `shop.myshopifyDomain` ==
  `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN`; fail-closed.
- **Image rights (spec §9.3/§17):** scraped images are quarantined by default
  and not published unless rights are confirmed (`trustImages:true`).
  - **Standing owner attestation (supplier sources).** The store owner has
    declared that **any storefront URL they input is one of their own suppliers**,
    with images permitted for resale listings — satisfying the spec's
    "supplier-origin / manually approved by the owner" path. Therefore, for
    owner-provided storefront URLs, run with `map.trustImages:true` so images are
    treated as approved and skip the quarantine (the default for
    `runPipelineFromUrl` / `bulk-from-url` / `pilot-from-url`).
  - This blanket approval rests entirely on the owner's rights attestation and is
    their legal responsibility. It applies to **owner-provided storefront URLs**;
    arbitrary/unverified image URLs from other contexts still stay quarantined.
    - Example confirmed source: `juliaandanne.com`.
- **Original content (spec §5.2/§10):** names/descriptions are generated, never
  copied from competitors.
- **Pilot before bulk (spec §14.1/§15):** validate 3–5 products first.
- **Products are created DRAFT;** publishing is a separate, opt-in step.

## Pipeline Supervisor Playbook

Run staged, and **pause for explicit user confirmation at the dry-run gate**
before any store mutation.

1. **Auth check** — `npm run test:auth`. Stop if scopes/connection fail.
2. **Ingest** — provide a product JSON (`examples/serane.json`) or scrape via
   `runPipelineFromUrl(url)` (writes off).
3. **Validate** — `npm run validate:input <file>`. Errors block; resolve before
   continuing.
4. **Transform self-check** — `npm run verify:transforms` (deterministic rules).
5. **Image mapping** — `npm run demo:images` (or review per product); confirm
   every color variant has an approved image; quarantined images stay out.
6. **DRY-RUN GATE 🔶 (pause here)** — run `npm run dry-run`, print the raw
   `productSet` payload + local pre-flight QA results, and **STOP. Ask the user
   to review and explicitly approve** (e.g. "Approve creating this DRAFT?").
   Do not proceed to any write without a clear yes.
7. **Execute (only after approval)** — `node --env-file=.env scripts/pilot-run.js`
   creates ONE DRAFT behind the identity guard; capture the product ID + admin
   link; IDs logged to `logs/`.
8. **Review** — user inspects the DRAFT in Shopify admin.
9. **Collections** — verify/create the group collection and assign.
10. **Publish (opt-in, after approval)** — `publishablePublish` to Online Store
    (+ Google once that channel is installed).
11. **Rollback if rejected** — `node --env-file=.env scripts/rollback.js <gid>`.
12. **Scale** — only after a pilot is approved (and Merchant Center validated).

> The dry-run gate (step 6) is mandatory: never run a write step without first
> showing the payload and getting explicit confirmation.

## Known caveats

- Google sales channel is not installed on the store yet — publishing reaches
  Online Store only until it's added (then auto-detected by `publish.js`).
- Example image URLs (`example.com`) fail Shopify media ingestion; real products
  need resolvable, approved supplier image URLs.

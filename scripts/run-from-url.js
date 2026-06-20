/**
 * Stage 0 pipeline runner (NO WRITES). Scrapes a URL, maps to inputs, builds
 * drafts, and prints the dry-run payload for review. Stops at the dry-run gate —
 * never creates products (see the Supervisor Playbook in CLAUDE.md).
 *
 *   node --env-file=.env scripts/run-from-url.js <url> [limit]
 */

'use strict';

import { runPipelineFromUrl } from '../src/pipeline.js';
import { buildProductSetOperation } from '../src/shopify/payload-builder.js';

const url = process.argv[2];
const limit = Number(process.argv[3] || 3);
const trustImages = process.argv.includes('trust'); // owner-confirmed supplier source
if (!url) { console.error('Usage: node --env-file=.env scripts/run-from-url.js <url> [limit] [trust]'); process.exit(2); }

console.log(`→ Stage 0 scrape (writes OFF, limit ${limit}, trustImages=${trustImages}): ${url}\n`);

const results = await runPipelineFromUrl(url, {
  limit,
  scrape: { actorInput: { startUrls: [{ url }], maxItems: limit } },
  map: { trustImages },
});
// Names are assigned uniquely up front inside runPipelineFromUrl (no post-build
// rename), so title, SKU, and copy always agree — nothing to dedupe here.

const built = results.filter((r) => r.draft);
console.log(`Scraped & built ${built.length} draft(s).\n`);
built.forEach((r, idx) => {
  console.log(`--- product ${idx + 1} ---`);
  console.log(`  title      : ${r.draft.title}`);
  console.log(`  type/dress : ${r.draft.productType} / isDress=${r.draft.isDress}`);
  console.log(`  options    : colors=${r.input.colors.join('|')}  sizes=${r.input.sizes.join('|')}`);
  console.log(`  variants   : ${r.draft.variants.length}  sample ${r.draft.variants[0]?.sku} $${r.draft.variants[0]?.price}/$${r.draft.variants[0]?.compareAtPrice}`);
  console.log(`  category   : ${r.draft.category.id}`);
  console.log(`  images     : approved=${r.draft.media.length}  quarantined=${r.unverifiedImages.length}`);
  console.log(`  QA         : ${r.qa?.ok ? '✅ pass' : '❌ ' + (r.qaErrors || []).join('; ')}`);
  if (r.notes.length) r.notes.forEach((n) => console.log(`  note       : ${n}`));
});
for (const r of results.filter((r) => r.buildError)) {
  console.log(`--- build failed: ${r.raw?.title || '?'} ---\n  ${r.buildError}`);
}

if (built[0]) {
  const op = buildProductSetOperation(built[0].draft, { status: 'DRAFT' });
  console.log('\n=== DRY-RUN payload (product 1, NOT executed) ===');
  console.log(JSON.stringify(op.variables.input, null, 2));
}

const qaFailed = results.some((r) => r.qaErrors || r.buildError);
console.log('\n🔶 DRY-RUN GATE: no products were created. Review above and explicitly approve before any write step.');
if (qaFailed) {
  console.log('❌ QA gate found problems above — resolve them before executing.');
  process.exitCode = 1;
}

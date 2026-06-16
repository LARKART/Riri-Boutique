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
if (!url) { console.error('Usage: node --env-file=.env scripts/run-from-url.js <url> [limit]'); process.exit(2); }

console.log(`→ Stage 0 scrape (writes OFF, limit ${limit}): ${url}\n`);

const results = await runPipelineFromUrl(url, {
  limit,
  scrape: { actorInput: { startUrls: [{ url }], maxItems: limit } },
  map: { sourceCurrency: 'CAD' },
});

// Cross-batch name dedup (spec §14.3): ensure invented names are unique per run.
const NAME_POOL = ['Serane', 'Elowen', 'Marielle', 'Avora', 'Celina', 'Evadra', 'Lirelle',
  'Noemi', 'Calla', 'Vesper', 'Ondine', 'Amaris', 'Sorrel', 'Thalia', 'Maren'];
const used = new Set();
for (const r of results) {
  let name = r.draft.name;
  if (used.has(String(name).toLowerCase())) {
    const alt = NAME_POOL.find((n) => !used.has(n.toLowerCase())) || `${name}-${used.size}`;
    r.notes.push(`Renamed "${name}" -> "${alt}" to keep names unique (§14.3).`);
    name = alt;
    r.draft.name = name;
    r.draft.title = `${r.draft.title.split(' | ')[0]} | ${name}`; // recompute (core unchanged)
  }
  used.add(String(name).toLowerCase());
}

console.log(`Scraped & built ${results.length} draft(s).\n`);
results.forEach((r, idx) => {
  console.log(`--- product ${idx + 1} ---`);
  console.log(`  title      : ${r.draft.title}`);
  console.log(`  type/dress : ${r.draft.productType} / isDress=${r.draft.isDress}`);
  console.log(`  options    : colors=${r.input.colors.join('|')}  sizes=${r.input.sizes.join('|')}`);
  console.log(`  variants   : ${r.draft.variants.length}  sample $${r.draft.variants[0]?.price}/$${r.draft.variants[0]?.compareAtPrice}`);
  console.log(`  category   : ${r.draft.category.id}`);
  console.log(`  images     : approved=${r.draft.media.length}  quarantined=${r.unverifiedImages.length}`);
  if (r.notes.length) r.notes.forEach((n) => console.log(`  note       : ${n}`));
});

if (results[0]) {
  const op = buildProductSetOperation(results[0].draft, { status: 'DRAFT' });
  console.log('\n=== DRY-RUN payload (product 1, NOT executed) ===');
  console.log(JSON.stringify(op.variables.input, null, 2));
}

console.log('\n🔶 DRY-RUN GATE: no products were created. Review above and explicitly approve before any write step.');

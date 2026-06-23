/**
 * Enrich under-described titles + fix category mismatches from SOURCE (read the
 * audit findings, re-map each product's source product through the CURRENT
 * transform, and update title/seo/category only when strictly richer/correct).
 *
 *   node --env-file=.env scripts/enrich-titles.js [--apply]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { mapApifyToInput } from '../src/transform/apifyToInput.js';
import { titleCore } from '../src/transform/title.js';
import { resolveCategory } from '../src/transform/taxonomy.js';
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const ORIGIN = 'https://www.byjuniperlane.com';
// store collection -> source slug + optional sleeve context for tops.
const SRC = [
  ['blouses-shirts-women'], ['long-sleeve-tops-women', 'Long Sleeve'], ['short-sleeve-tops-women', 'Short Sleeve'],
  ['sleeveless-tops-women', 'Sleeveless'], ['sweater-and-knits'], ['all-tops-women'], ['all-tunics-women'],
  ['sandals-women'], ['sliders-women'], ['heels-women'], ['flats-women'], ['mary-jane-shoes'], ['sneakers-women'],
  ['shorts-women'], ['one-piece-swim-women'], ['bikinis-women'], ['tankinis-women'], ['all-swimwear-women'],
];
const imageToken = (u) => (String(u || '').split('?')[0].split('/').pop() || '').replace(/^\d+_/, '').toLowerCase();
const coreOf = (t) => String(t || '').split(' | ')[0].trim();
const nameOf = (t) => (String(t || '').includes(' | ') ? t.split(' | ').pop().trim() : '');
const words = (s) => coreOf(s).split(/\s+/).filter(Boolean).length;
const noGql = async () => { throw new Error('gql not expected for flagged type'); };

// 1) Source index: image token -> { raw, sleeve }.
const srcIndex = new Map();
for (const [slug, sleeve] of SRC) {
  for (let page = 1; page <= 10; page++) {
    let b; try { b = await (await fetch(`${ORIGIN}/collections/${slug}/products.json?limit=250&page=${page}`)).json(); } catch { break; }
    const ps = b.products || [];
    for (const p of ps) for (const im of p.images || []) { const t = imageToken(im.src); if (t && !srcIndex.has(t)) srcIndex.set(t, { raw: p, sleeve }); }
    if (ps.length < 250) break;
  }
}
console.log(`Source index: ${srcIndex.size} image tokens from ${SRC.length} collections.`);

// 2) Targets from the audit: bare titles + category mismatches.
const audit = JSON.parse(fs.readFileSync('/tmp/claude-0/-home-user-Riri-Boutique/edb3f54d-d602-5236-bcb6-52d60d84d362/scratchpad/audit.json', 'utf8'));
const targetIds = [...new Set(audit.findings.filter((f) => f.check === 'title.bare' || f.check === 'category.mismatch').map((f) => f.id))];
console.log(`Targets: ${targetIds.length} products (bare titles + category mismatches).\n`);

// 3) Fetch target product detail (media tokens, options, name, seo, category).
const NODES = `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id title seo{title} category{id}
  collections(first:15){nodes{title}} media(first:30){nodes{... on MediaImage{image{url}}}}
  options(first:6){name optionValues{name}} } } }`;
const prods = [];
for (let i = 0; i < targetIds.length; i += 50) {
  const d = await shopifyGraphQL(NODES, { ids: targetIds.slice(i, i + 50) });
  prods.push(...d.nodes.filter(Boolean));
}

const UPD = `mutation($input:ProductInput!){ productUpdate(input:$input){ product{id} userErrors{field message} } }`;
// productUpdate's SEOInput is a no-op in this API version; seo.title is backed by
// the global.title_tag metafield, so set it directly.
const MF = `mutation($mf:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ userErrors{field message} } }`;
let enrichTitle = 0, fixCat = 0, noSource = 0, noGain = 0, fail = 0;
const samples = [];
for (const p of prods) {
  const tokens = [...new Set(p.media.nodes.map((m) => imageToken(m.image?.url)).filter(Boolean))];
  const hit = tokens.map((t) => srcIndex.get(t)).find(Boolean);
  if (!hit) { noSource++; continue; }
  const name = nameOf(p.title);
  const collTitles = p.collections.nodes.map((c) => c.title);
  let sleeveContext = hit.sleeve;
  if (!sleeveContext) { if (collTitles.includes('Long Sleeve Tops')) sleeveContext = 'Long Sleeve'; else if (collTitles.includes('Short Sleeve Tops')) sleeveContext = 'Short Sleeve'; else if (collTitles.includes('Sleeveless Tops')) sleeveContext = 'Sleeveless'; }
  let input;
  try { ({ input } = mapApifyToInput(hit.raw, { trustImages: true, linkage: hit.raw, sourceCurrency: 'CAD', sleeveContext })); }
  catch { noSource++; continue; }
  const draftish = { ...input, attributes: input.attributes || {} };
  const newCore = titleCore(draftish);
  let newCat; try { newCat = (await resolveCategory(draftish, noGql)).id; } catch { newCat = p.category?.id; }
  const newTitle = name ? `${newCore} | ${name}` : newCore;

  const titleRicher = newCore !== coreOf(p.title) && words(newTitle) > words(p.title);
  const catWrong = newCat && newCat !== p.category?.id;
  if (!titleRicher && !catWrong) { noGain++; continue; }

  const inputUpd = { id: p.id };
  if (titleRicher) { inputUpd.title = newTitle; enrichTitle++; }
  if (catWrong) { inputUpd.category = newCat; fixCat++; }
  if (samples.length < 30) samples.push(`  ${titleRicher ? '✎' : ' '}${catWrong ? '⊞' : ' '} "${coreOf(p.title)}"${titleRicher ? ` -> "${newCore}"` : ''}${catWrong ? `  cat ${p.category?.id?.split('/').pop()}->${newCat.split('/').pop()}` : ''}`);
  if (APPLY) {
    try {
      const r = await shopifyGraphQL(UPD, { input: inputUpd }); if (r.productUpdate.userErrors.length) throw new Error(JSON.stringify(r.productUpdate.userErrors));
      if (titleRicher) { const m = await shopifyGraphQL(MF, { mf: [{ ownerId: p.id, namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: newTitle }] }); if (m.metafieldsSet.userErrors.length) throw new Error(JSON.stringify(m.metafieldsSet.userErrors)); }
    }
    catch (e) { fail++; console.log(`    ❌ ${p.title}: ${e.message}`); }
  }
}
console.log(`\n— ${APPLY ? 'APPLIED' : 'DRY-RUN'} —`);
samples.forEach((s) => console.log(s));
console.log(`\nTitles enriched: ${enrichTitle} | categories fixed: ${fixCat} | no-source-match: ${noSource} | no-gain (already best): ${noGain}${fail ? ` | failed: ${fail}` : ''}`);

/**
 * Backfill mm-google-shopping.pattern (+ inferred base color) on print products
 * whose colour option is a pattern (Floral/Geometric/Striped/Colorblock/…) but
 * which lack the feed pattern metafield. "Multicolor" is treated as an acceptable
 * color value (not a pattern) and skipped. Base color is inferred from the
 * product's own title + description (no source needed). Pattern-only products get
 * the color override; mixed (pattern + real color) get pattern only.
 *
 *   node --env-file=.env scripts/fix-pattern-metafields.js [--apply]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { normalizePattern } from '../src/normalize/patterns.js';
import { inferBaseColor } from '../src/normalize/patterns.js';
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const FEED_NS = 'mm-google-shopping';
const audit = JSON.parse(fs.readFileSync('/tmp/claude-0/-home-user-Riri-Boutique/edb3f54d-d602-5236-bcb6-52d60d84d362/scratchpad/auditA.json', 'utf8'));
const ids = [...new Set(audit.findings.filter((f) => f.check === 'pattern.no_metafield').map((f) => f.id))];

const NODES = `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id title
  options(first:6){ name optionValues{ name } }
  metafields(first:40){ nodes{ namespace key } }
  m1: metafield(namespace:"global", key:"description_tag"){ value }
  descriptionHtml } } }`;
const MF = `mutation($mf:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ userErrors{field message} } }`;

const prods = [];
for (let i = 0; i < ids.length; i += 50) { const d = await shopifyGraphQL(NODES, { ids: ids.slice(i, i + 50) }); prods.push(...d.nodes.filter(Boolean)); }

let setPat = 0, setColor = 0, skipMulti = 0, fail = 0; const samples = [];
for (const p of prods) {
  const colOpt = (p.options || []).find((o) => /colou?r/i.test(o.name));
  const vals = (colOpt?.optionValues || []).map((v) => v.name);
  const patterns = [...new Set(vals.map((v) => normalizePattern(v)).filter(Boolean))];
  if (!patterns.length) { skipMulti++; continue; } // Multicolor/real colors only -> acceptable, no pattern
  const realColor = vals.some((v) => !normalizePattern(v) && !/multicolou?r|default/i.test(v));
  const has = (k) => p.metafields.nodes.some((m) => m.namespace === FEED_NS && m.key === k);
  const mf = [];
  if (!has('pattern')) mf.push({ ownerId: p.id, namespace: FEED_NS, key: 'pattern', type: 'single_line_text_field', value: patterns.join(' / ') });
  let baseColor = null;
  if (!realColor && !has('color')) { baseColor = inferBaseColor(`${p.title} ${p.m1?.value || ''} ${String(p.descriptionHtml || '').replace(/<[^>]+>/g, ' ')}`); mf.push({ ownerId: p.id, namespace: FEED_NS, key: 'color', type: 'single_line_text_field', value: baseColor }); }
  if (!mf.length) continue;
  if (mf.some((m) => m.key === 'pattern')) setPat++;
  if (mf.some((m) => m.key === 'color')) setColor++;
  if (samples.length < 12) samples.push(`  "${p.title}" pattern=${patterns.join('/')}${baseColor ? ` color=${baseColor}` : ' (mixed: color from option)'}`);
  if (APPLY) { try { const r = await shopifyGraphQL(MF, { mf }); if (r.metafieldsSet.userErrors.length) throw new Error(JSON.stringify(r.metafieldsSet.userErrors)); } catch (e) { fail++; console.log(`  ❌ ${p.title}: ${e.message}`); } }
}
console.log(`\n— ${APPLY ? 'APPLIED' : 'DRY-RUN'} —`);
samples.forEach((s) => console.log(s));
console.log(`\nProducts: ${prods.length} | pattern set: ${setPat} | base-color set: ${setColor} | skipped (Multicolor/real-color): ${skipMulti}${fail ? ` | failed: ${fail}` : ''}`);

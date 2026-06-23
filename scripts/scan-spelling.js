/**
 * Canadian-spelling scan (READ-ONLY). For each US term, count distinct products
 * where it appears, split by location: TITLE / COLOUR option VALUE / DESCRIPTION.
 *   node --env-file=.env scripts/scan-spelling.js
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import fs from 'node:fs';

const TERMS = [
  ['gray → grey', /\bgray(ish)?\b/i],
  ['color → colour', /color(?!u)/i], // color, colored, colorful, colorblock, multicolor
  ['favorite/favor → favour', /\bfavor(?!u)\w*\b/i],
  ['jewelry → jewellery', /\bjewelry\b/i],
  ['fiber → fibre', /\bfibers?\b/i],
  ['cozy → cosy', /\bcoz(y|ier|iest)\b/i],
  ['-ize → -ise', /\b(?:organ|real|custom|special|emphas|modern|minim|maxim|prior|stabil|styl|accessor|optim|person|normal|coordin|character|symbol|util|civil)iz(?:e|ed|es|ing|ation)\b/i],
  ['-l → -ll (traveler/modeling/marvelous)', /\b(?:travel|jewel|label|model|marvel|cancel|tunnel|fuel|signal|funnel)(?:ed|er|ers|ing|ling|ous)\b/i],
  ['catalog → catalogue', /\bcatalog(?!ue)\w*\b/i],
  ['theater → theatre', /\btheater\b/i],
  ['meter → metre', /\b(?:centi|milli|kilo)?meters?\b/i],
  ['-or → -our (honor/humor/neighbor/etc.)', /\b(?:honor|humor|neighbor|labor|savor|flavor|glamor|vapor|odor|valor|vigor|harbor|behavior|armor|rumor|tumor|splendor|ardor|candor)\w*\b/i],
  ['-se → -ce (defense/license/offense)', /\b(?:defense|offense|license|pretense)\w*\b/i],
  ['other US (aluminum/pajamas/mold/mustache/plow/smolder)', /\b(?:aluminum|pajamas?|molded?|molding|mustache|plow\w*|smolder\w*)\b/i],
];

const coreTitle = (t) => String(t || '');
const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, ' ');

const counts = {}; // term -> {title:Set, value:Set, desc:Set, valueExamples:Map}
for (const [label] of TERMS) counts[label] = { title: new Set(), value: new Set(), desc: new Set(), valEx: new Map() };

let after = null, total = 0, page = 0;
do {
  page++;
  let d; try { d = await shopifyGraphQL(`query($a:String){ products(first:10,after:$a){ pageInfo{hasNextPage endCursor} nodes{ id title descriptionHtml options(first:6){ name optionValues{ name } } } } }`, { a: after }); }
  catch (e) { console.error('page', page, e.message); await new Promise((r) => setTimeout(r, 1500)); continue; }
  for (const p of d.products.nodes) {
    total++;
    const title = coreTitle(p.title);
    const colOpt = (p.options || []).find((o) => /colou?r/i.test(o.name));
    const vals = (colOpt?.optionValues || []).map((v) => v.name);
    const desc = stripHtml(p.descriptionHtml);
    for (const [label, re] of TERMS) {
      const c = counts[label];
      if (re.test(title)) c.title.add(p.id);
      for (const v of vals) if (re.test(v)) { c.value.add(p.id); c.valEx.set(v, (c.valEx.get(v) || 0) + 1); }
      if (re.test(desc)) c.desc.add(p.id);
    }
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);

console.log(`\nScanned ${total} products\n`);
const rows = [];
for (const [label] of TERMS) {
  const c = counts[label];
  const tot = new Set([...c.title, ...c.value, ...c.desc]).size;
  rows.push({ label, tot, title: c.title.size, value: c.value.size, desc: c.desc.size, valEx: [...c.valEx.entries()] });
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('TERM', 46) + pad('TOTAL', 7) + pad('TITLE', 7) + pad('COLOUR-VAL', 12) + 'DESC');
for (const r of rows) console.log(pad(r.label, 46) + pad(r.tot, 7) + pad(r.title, 7) + pad(r.value, 12) + r.desc);

console.log('\n=== FEED-AFFECTING (colour option VALUES) — DO NOT CHANGE YET ===');
for (const r of rows) if (r.value) console.log(`  ${r.label}: ${r.value} products | values: ${r.valEx.map(([v, n]) => `"${v}"×${n}`).join(', ')}`);

fs.writeFileSync('/tmp/claude-0/-home-user-Riri-Boutique/edb3f54d-d602-5236-bcb6-52d60d84d362/scratchpad/spelling.json', JSON.stringify(rows, null, 0));

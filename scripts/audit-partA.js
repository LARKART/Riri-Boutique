/**
 * PART A audit (READ-ONLY): inventory settings, pattern handling, alt text,
 * handles. Paginates all products and reports per-check counts + examples.
 *   node --env-file=.env scripts/audit-partA.js
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import fs from 'node:fs';

const OUT='/tmp/claude-0/-home-user-Riri-Boutique/edb3f54d-d602-5236-bcb6-52d60d84d362/scratchpad/auditA.json';
const FEED_NS='mm-google-shopping';
const PATTERN_RE=/\b(floral|striped|stripe|geometric|colou?rblock|patchwork|chevron|paisley|polka|gingham|plaid|houndstooth|camo|camouflage|animal|leopard|tiger|zebra|snake|abstract|tropical|tie[-\s]?dye|ditsy|multicolor|multicolour)\b/i;
const NAMED=/^(black|white|ivory|cream|beige|tan|brown|grey|gray|navy|blue|teal|green|olive|yellow|gold|orange|coral|red|burgundy|wine|pink|rose|purple|lavender|lilac|silver|charcoal|khaki|mauve|peach|mint|sage|nude|champagne|apricot|rust|mustard|emerald|turquoise|fuchsia|magenta|maroon|slate|stone|sand|taupe|aqua|lime|plum|berry|chocolate|camel|denim|indigo|cobalt|salmon|blush|bronze|copper|pewter|ecru|oatmeal|caramel|cognac|terracotta|dark.*|light.*|.*\/.* )$/i;
const coreOf=(t)=>String(t||'').split(' | ')[0].trim();

const findings=[];
let after=null,total=0,page=0;
const handles=new Map();
const Q=`query($a:String){ products(first:5,after:$a){ pageInfo{hasNextPage endCursor}
 nodes{ id title handle
  options(first:6){ name optionValues{ name } }
  metafields(first:40){ nodes{ namespace key value } }
  media(first:40){ nodes{ ... on MediaImage { alt image{ url } } } }
  variants(first:100){ nodes{ sku inventoryPolicy inventoryItem{ tracked } image{ id } } } } } }`;
do {
  page++;
  let d; try{ d=await shopifyGraphQL(Q,{a:after}); }catch(e){ console.error('page',page,e.message); break; }
  for (const p of d.products.nodes) {
    total++;
    const colls=[]; const add=(check,detail)=>findings.push({id:p.id,title:p.title,check,detail});
    // 4 HANDLES
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.handle||'')) add('handle.malformed',`handle "${p.handle}"`);
    if (!handles.has(p.handle)) handles.set(p.handle,[]); handles.get(p.handle).push(p.title);
    // 1 INVENTORY
    const vs=p.variants.nodes;
    const tracked=vs.filter((v)=>v.inventoryItem?.tracked===true).length;
    const deny=vs.filter((v)=>v.inventoryPolicy!=='CONTINUE').length;
    if (tracked) add('inv.tracked',`${tracked}/${vs.length} variants tracked=true`);
    if (deny) add('inv.deny',`${deny}/${vs.length} variants inventoryPolicy!=CONTINUE (e.g. ${vs.find((v)=>v.inventoryPolicy!=='CONTINUE')?.sku})`);
    // 3 ALT TEXT
    const imgs=p.media.nodes.filter((m)=>m && m.image);
    const noAlt=imgs.filter((m)=>!String(m.alt||'').trim()).length;
    if (imgs.length && noAlt) add('alt.missing',`${noAlt}/${imgs.length} images missing alt`);
    // 2 PATTERN
    const colOpt=(p.options||[]).find((o)=>/colou?r/i.test(o.name));
    const colVals=(colOpt?.optionValues||[]).map((v)=>v.name);
    const patVals=colVals.filter((c)=>PATTERN_RE.test(c) && !NAMED.test(String(c).trim().toLowerCase()));
    const mf=p.metafields.nodes;
    const hasPatMf=mf.some((m)=>m.namespace===FEED_NS&&m.key==='pattern');
    const hasColorMf=mf.some((m)=>m.namespace===FEED_NS&&m.key==='color');
    if (patVals.length) {
      if (!hasPatMf) add('pattern.no_metafield',`pattern color(s) [${patVals.join(',')}] but no ${FEED_NS}.pattern`);
      const onlyPat=colVals.every((c)=>PATTERN_RE.test(c)&&!NAMED.test(String(c).trim().toLowerCase()));
      if (onlyPat && !hasColorMf) add('pattern.no_basecolor',`pattern-only but no ${FEED_NS}.color base color`);
      const realColors=colVals.filter((c)=>!PATTERN_RE.test(c)).length;
      if (realColors>=1 && PATTERN_RE.test(coreOf(p.title))) add('pattern.print_in_mixed_title',`print word in mixed-color title "${coreOf(p.title)}"`);
    }
  }
  after=d.products.pageInfo.hasNextPage?d.products.pageInfo.endCursor:null;
} while (after);

// duplicate handles
for (const [h,arr] of handles) if (arr.length>1) findings.push({id:'-',title:arr.join(' || '),check:'handle.duplicate',detail:`handle "${h}" used by ${arr.length} products`});

fs.writeFileSync(OUT,JSON.stringify({total,findings},null,0));
const by={}; for(const f of findings)(by[f.check] ||= []).push(f);
console.log(`\n===== PART A AUDIT (read-only) =====\nProducts scanned: ${total} | findings: ${findings.length}\n`);
for (const ck of ['inv.tracked','inv.deny','pattern.no_metafield','pattern.no_basecolor','pattern.print_in_mixed_title','alt.missing','handle.malformed','handle.duplicate']) {
  const fs2=by[ck]||[]; if(!fs2.length){console.log(`✅ ${ck}: 0`);continue;}
  console.log(`⚠️  ${ck}: ${fs2.length}`);
  for (const f of fs2.slice(0,4)) console.log(`      "${f.title}" — ${f.detail}`);
}
console.log(`\nJSON: ${OUT}`);

/**
 * Full catalog audit (READ-ONLY). Paginates every product and checks each field
 * against our standards. Writes a findings JSON to scratchpad and prints a
 * per-check, per-collection report with examples. No mutations.
 *
 *   node --env-file=.env scripts/audit-catalog.js [--out <file.json>]
 */
'use strict';
import { shopifyGraphQL } from '../src/shopify/client.js';
import { titleCore } from '../src/transform/title.js';
import fs from 'node:fs';

const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]
  : '/tmp/claude-0/-home-user-Riri-Boutique/edb3f54d-d602-5236-bcb6-52d60d84d362/scratchpad/audit.json';

// ---- expected taxonomy node from the garment noun in the title/type ----------
const DRESS='gid://shopify/TaxonomyCategory/aa-1-4';
const node=(x)=>`gid://shopify/TaxonomyCategory/${x}`;
function expectedCategory(text) {
  const t=String(text||'');
  if (/\b(dress|gown)\b/i.test(t)) return { id: DRESS, kind:'dress' };
  if (/\bbikini\b/i.test(t)) return { id: node('aa-1-20-6'), kind:'bikini' };
  if (/\b(one[-\s]?piece|monokini)\b/i.test(t)) return { id: node('aa-1-20-22'), kind:'one-piece' };
  if (/\btankini\b/i.test(t)) return { id: node('aa-1-20'), kind:'tankini' };
  if (/\b(swimsuit|swimwear|bathing\s*suit)\b/i.test(t)) return { id: node('aa-1-20'), kind:'swimwear' };
  if (/\b(sandals?|slides?)\b/i.test(t)) return { id: node('aa-8-6'), kind:'sandals/slides' };
  if (/\bmary\s*jane/i.test(t)) return { id:/\b(heel|stiletto|block\s*heel)\b/i.test(t)?node('aa-8-10'):node('aa-8-9'), kind:'mary jane' };
  // Boots/mules/loafers/etc. use generic Shoes even when the name contains "heel"
  // (e.g. "Block Heel Boots") — check them BEFORE the heels branch.
  if (/\b(loafers?|oxfords?|mules?|clogs?|boots?|booties?|espadrilles?)\b/i.test(t)) return { id: node('aa-8'), kind:'other-shoe' };
  if (/\b(heels?|pumps?)\b/i.test(t)) return { id: node('aa-8-10'), kind:'heels' };
  if (/\b(ballet|flats?)\b/i.test(t)) return { id: node('aa-8-9'), kind:'flats' };
  if (/\b(sneakers?|trainers?)\b/i.test(t)) return { id: node('aa-8-8'), kind:'sneakers' };
  if (/\b(romper|jumpsuit|two[-\s]?piece|co[-\s]?ord|set)\b/i.test(t)) return { id: node('aa-1-11'), kind:'set' };
  if (/\bshorts\b/i.test(t)) return { id: node('aa-1-14'), kind:'shorts' };
  if (/\bjeans?\b/i.test(t)) return { id: node('aa-1-12-4'), kind:'jeans' };
  if (/\b(pants?|trousers?|leggings?|culottes?|joggers?|palazzo)\b/i.test(t)) return { id: node('aa-1-12'), kind:'pants' };
  if (/\bskirt\b/i.test(t)) return { id: node('aa-1-15'), kind:'skirt' };
  if (/\b(sweater|pullover|jumper)\b/i.test(t)) return { id: node('aa-1-13-12'), kind:'sweater' };
  if (/\bcardigan\b/i.test(t)) return { id: node('aa-1-13-3'), kind:'cardigan' };
  if (/\bhoodie\b/i.test(t)) return { id: node('aa-1-13-13'), kind:'hoodie' };
  if (/\bsweat\s?shirt\b/i.test(t)) return { id: node('aa-1-13-14'), kind:'sweatshirt' };
  if (/\b(blouse|shirt|tank|cami(?:sole)?|tunic|peplum|bodysuit|knit|tops?)\b/i.test(t)) return { id: node('aa-1-13-1'), kind:'top' };
  return null;
}

const SIZE_RE=/^(?:xxs|xs|s|m|l|xl|2xl|3xl|4xl|5xl|xxl|xxxl|one size|os|(?:us|uk|eu|au)?\s?\d{1,2}(?:\.\d)?\s?(?:us|uk|eu|au)?|\d{1,2}(?:\.\d)?\s?[–-]\s?\d{1,2}(?:\.\d)?\s?(?:us|uk|eu|au)?)$/i;
const STOCK_RE=/\(.*(sold\s*out|almost|few left|low stock|selling)\b.*\)|almost\s*sold|only\s*\d+\s*left/i;
const US_PREFIX_RE=/\b(us|uk|eu|au)\b/i;
const PATTERN_RE=/\b(floral|striped|stripe|geometric|colou?rblock|patchwork|chevron|paisley|polka|gingham|plaid|houndstooth|camo|camouflage|animal|leopard|tiger|zebra|snake|abstract|tropical|tie[-\s]?dye|ditsy)\b/i;
const LENGTH_RE=/\b(mini|midi|maxi|knee length|tea length|floor length|ankle length)\b/i;
const FEED_NS='mm-google-shopping';
const FEED_KEYS=['gender','age_group','condition','custom_product'];
const BARE_NOUN=/^Women's (Dress|Bikini|Tankini|Swimsuit|One Piece Swimsuit|Sandals|Slides|Slide Sandals|Heels|Flats|Sneakers|Pants|Jeans|Trousers|Leggings|Skirt|Blouse|Shirt|Top|Tank Top|Camisole|Tunic|Sweater|Cardigan|Hoodie|Shorts|Mary Janes|Shoes|Loafers|Mules)$/i;

const nameOf=(t)=> (String(t||'').includes(' | ') ? t.split(' | ').pop().trim() : '');
const coreOf=(t)=> String(t||'').split(' | ')[0].trim();

const PER_PAGE=5;
const findings=[]; // {id,title,colls,check,detail,fix?}
let after=null, total=0, page=0;
const Q=`query($a:String){ products(first:${PER_PAGE},after:$a){ pageInfo{hasNextPage endCursor}
  nodes{ id title status productType tags category{id fullName} seo{title} mediaCount{count}
    collections(first:15){nodes{title}}
    options(first:6){ name optionValues{ name } }
    metafields(first:40){ nodes{ namespace key value } }
    variants(first:100){ nodes{ sku price compareAtPrice image{ id } } } } } }`;

do {
  page++;
  let d; try { d=await shopifyGraphQL(Q,{a:after}); }
  catch(e){ console.error('page',page,'err',e.message); break; }
  for (const p of d.products.nodes) {
    total++;
    const colls=p.collections.nodes.map((c)=>c.title);
    const title=p.title, core=coreOf(title), name=nameOf(title);
    const add=(check,detail,fix)=>findings.push({id:p.id,title,colls,check,detail,...(fix?{fix}:{})});
    const colOpt=(p.options||[]).find((o)=>/colou?r/i.test(o.name));
    const sizeOpt=(p.options||[]).find((o)=>/size/i.test(o.name));
    const colVals=(colOpt?.optionValues||[]).map((v)=>v.name);
    const sizeVals=(sizeOpt?.optionValues||[]).map((v)=>v.name);
    const exp=expectedCategory(core);
    const isShoe=exp && /aa-8/.test(exp.id);
    const isDress=exp?.kind==='dress';

    // 1 TITLES
    if (!/^Women's\b/.test(title)) add('title.structure','does not start with "Women\'s"');
    if (!name) add('title.noname','no " | Name" suffix');
    if (BARE_NOUN.test(core)) add('title.bare',`bare/under-described core "${core}"`);
    if (isDress && !LENGTH_RE.test(core)) add('title.dress_no_length',`dress title missing length: "${core}"`);
    if (!isDress && exp && LENGTH_RE.test(core) && !/aa-1-15/.test(exp.id)) add('title.length_on_nondress',`length token on non-dress: "${core}"`);
    if (/\bone[-\s]?piece\b/i.test(core) && /\bset\b/i.test(core)) add('title.set_on_onepiece',`"Set" on one-piece: "${core}"`);
    if (PATTERN_RE.test(core) && colVals.filter((c)=>c && c.toLowerCase()!=='default').length>=2) add('title.print_mixedcolor',`print word in title with ${colVals.length} colors: "${core}"`);

    // 2 CATEGORY
    if (exp && p.category?.id!==exp.id) add('category.mismatch',`got ${p.category?.id||'(none)'} expected ${exp.id} (${exp.kind})`,{setCategory:exp.id});
    if (!p.category?.id) add('category.missing','no category set');

    // 3 SIZES
    for (const c of colVals) if (SIZE_RE.test(String(c).trim())) add('size.in_color',`size-like value in Color: "${c}"`);
    if (isShoe) for (const s of sizeVals) { if (US_PREFIX_RE.test(s)) add('size.us_prefix',`shoe size has locale label: "${s}"`); }

    // 4 COLORS
    for (const c of colVals) { if (STOCK_RE.test(c)) add('color.stock_phrase',`stock phrase in color: "${c}"`); }
    if (colVals.some((c)=>String(c).trim().toLowerCase()==='default')) add('color.default','color value "Default" present');

    // 5 METAFIELDS
    const mf=p.metafields.nodes;
    const missing=FEED_KEYS.filter((k)=>!mf.some((m)=>m.namespace===FEED_NS&&m.key===k));
    if (missing.length) add('metafield.missing',`missing ${FEED_NS}: ${missing.join(',')}`,{addFeed:missing});

    // 6 SEO
    if (!String(p.seo?.title||'').trim()) add('seo.empty','empty seo.title',{setSeo:title});
    else if (name && !p.seo.title.includes(name)) add('seo.mismatch',`seo.title "${p.seo.title}" lacks name "${name}"`);

    // 7 IMAGES / PRICING
    if ((p.mediaCount?.count||0)===0) add('media.zero','product has zero media');
    const vs=p.variants.nodes;
    const nullImg=vs.filter((v)=>!v.image).length;
    if (nullImg) add('variant.null_image',`${nullImg}/${vs.length} variants have no image`);
    for (const v of vs) {
      const pr=Number(v.price), cmp=Number(v.compareAtPrice);
      if (!(cmp>pr)) { add('price.compare_le',`variant ${v.sku} compareAt ${v.compareAtPrice} <= price ${v.price}`); break; }
    }
    for (const v of vs) {
      if (!/\.(95)$/.test(String(v.price))) { add('price.noncharm',`variant ${v.sku} price ${v.price} not charm .95`); break; }
    }
  }
  after=d.products.pageInfo.hasNextPage?d.products.pageInfo.endCursor:null;
  if (page%20===0) console.error(`...scanned ${total}`);
} while (after);

fs.writeFileSync(OUT, JSON.stringify({ total, findings }, null, 0));

// ---- report ----
const byCheck={};
for (const f of findings){ (byCheck[f.check] ||= []).push(f); }
console.log(`\n================ CATALOG AUDIT (read-only) ================`);
console.log(`Products scanned: ${total} | total findings: ${findings.length}\n`);
const order=['title.structure','title.noname','title.bare','title.dress_no_length','title.length_on_nondress','title.set_on_onepiece','title.print_mixedcolor',
  'category.mismatch','category.missing','size.in_color','size.us_prefix','color.stock_phrase','color.default',
  'metafield.missing','seo.empty','seo.mismatch','media.zero','variant.null_image','price.compare_le','price.noncharm'];
for (const ck of order) {
  const fs2=byCheck[ck]||[]; if (!fs2.length){ console.log(`✅ ${ck}: 0`); continue; }
  // per-collection counts
  const perColl={};
  for (const f of fs2) for (const c of (f.colls.length?f.colls:['(none)'])) perColl[c]=(perColl[c]||0)+1;
  const top=Object.entries(perColl).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([c,n])=>`${c}:${n}`).join(', ');
  console.log(`⚠️  ${ck}: ${fs2.length}  [${top}]`);
  for (const f of fs2.slice(0,3)) console.log(`      e.g. "${f.title}" — ${f.detail}`);
}
console.log(`\nFindings JSON: ${OUT}`);

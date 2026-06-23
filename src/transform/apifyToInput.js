/**
 * Stage 0 transformer: Apify raw Shopify product -> our product-input contract.
 *
 * Maps STRUCTURE only (productType, colors, sizes, per-variant price, attributes)
 * per spec §4/§17. Does NOT carry the competitor's name (spec §5.2 — invented in
 * Stage 6) and does NOT place scraped images into approved `images[]` unless
 * `trustImages:true` (spec §9.3/§17 — rights must be confirmed). Returns
 * { input, unverifiedImages, notes } where `input` is schema-valid.
 *
 * This actor's shape (observed): variants carry option1/option2/option3 (no
 * top-level `options`); `productType` may be null; `currency` is provided;
 * images are { src, width, height } with no variant linkage.
 */

'use strict';

import { detectLength } from './lengths.js';
import { normalizeColorName, stripStockSuffix } from '../normalize/colors.js';
import { normalizePattern, inferBaseColor } from '../normalize/patterns.js';

const NECKLINES = ['One Shoulder', 'Off Shoulder', 'Off-Shoulder', 'V Neck', 'V-Neck', 'Square Neck',
  'Halter', 'Sweetheart', 'Cowl Neck', 'Cowl', 'Strapless', 'Scoop Neck', 'Boat Neck', 'High Neck',
  'Mock Neck', 'Turtleneck', 'Crew Neck', 'Round Neck'];
const SLEEVES = ['Long Sleeve', 'Short Sleeve', 'Cap Sleeve', 'Puff Sleeve', '3/4 Sleeve',
  'Ruffle Sleeve', 'Bell Sleeve', 'Flutter Sleeve', 'Wide Sleeve', 'Sleeveless'];
const SILHOUETTES = ['A-Line', 'Bodycon', 'Slip', 'Wrap', 'Pleated', 'Draped', 'Mermaid', 'Fit and Flare', 'Tiered',
  'Button Down', 'Button Up', 'Collared', 'Smocked', 'Tie Front', 'Peplum', 'Cutout', 'Push Up', 'Cross Front', 'Ruched'];
const OCCASIONS = [['wedding guest', 'Wedding Guest'], ['bridesmaid', 'Bridesmaid'], ['cocktail', 'Cocktail'],
  ['formal', 'Formal'], ['prom', 'Prom'], ['party', 'Party'], ['vacation', 'Vacation'], ['evening', 'Evening']];

const SIZE_RE = /^(?:xxs|xs|s|m|l|xl|2xl|3xl|4xl|5xl|xxl|xxxl|one size|os|(?:us|uk|eu|au)?\s?\d{1,2}(?:\.\d)?\s?(?:us|uk|eu|au)?|\d{1,2}(?:\.\d)?\s?[–-]\s?\d{1,2}(?:\.\d)?\s?(?:us|uk|eu|au)?|.*\((?:xxs|xs|s|m|l|xl|2xl|3xl|4xl|5xl|xxl|xxxl)\))$/i;

/** Garment-type token for a two-piece set / one-piece outfit, from the title. */
function detectSetType(title) {
  const t = String(title || '').toLowerCase();
  if (/\bromper\b/.test(t)) return 'Romper';
  if (/\bjumpsuit\b/.test(t)) return 'Jumpsuit';
  if (/\bskirt\b/.test(t)) return 'Skirt Set';
  if (/\b(shorts?|biker)\b/.test(t)) return 'Short Set';
  if (/\b(pants?|trousers?|wide[-\s]?leg|leggings?)\b/.test(t)) return 'Pants Set';
  return 'Two Piece Set';
}

// Swimwear garment-type token + matching Shopify taxonomy node. Two-piece styles
// carry "Set" (a strong search term, e.g. "bikini set"); one-pieces never do.
function detectSwimType(text) {
  const t = String(text || '').toLowerCase();
  if (/one[-\s]?piece|monokini/.test(t)) return { noun: 'One Piece Swimsuit', cat: 'gid://shopify/TaxonomyCategory/aa-1-20-22' };
  if (/tankini/.test(t)) return { noun: 'Tankini Set', cat: 'gid://shopify/TaxonomyCategory/aa-1-20' };
  if (/bikini/.test(t)) return { noun: 'Bikini Set', cat: 'gid://shopify/TaxonomyCategory/aa-1-20-6' };
  return { noun: 'Swimsuit', cat: 'gid://shopify/TaxonomyCategory/aa-1-20' };
}

// Footwear garment-type noun (with Orthopedic + style baked in) + taxonomy node.
// "Orthopedic" is kept only when the source actually says so (never invented).
function detectFootwear(text) {
  const t = String(text || '');
  const base = /sandals?/i.test(t) ? { n: 'Sandals', cat: 'aa-8-6' }
    : /\b(slides?|sliders?)\b/i.test(t) ? { n: 'Slides', cat: 'aa-8-6' } // slide sandals
    : /(sneakers?|trainers?)/i.test(t) ? { n: 'Sneakers', cat: 'aa-8-8' }
    : /\bmary\s*jane/i.test(t) ? { n: 'Mary Janes', cat: /\b(heel|heeled|stiletto|block)\b/i.test(t) ? 'aa-8-10' : 'aa-8-9' }
    : /\b(ballet|flats?)\b/i.test(t) ? { n: 'Flats', cat: 'aa-8-9' }
    : /boots?/i.test(t) ? { n: 'Boots', cat: 'aa-8' }
    : /espadrilles?/i.test(t) ? { n: 'Espadrilles', cat: 'aa-8' }
    : /loafers?/i.test(t) ? { n: 'Loafers', cat: 'aa-8' }
    : /\bmules?\b/i.test(t) ? { n: 'Mules', cat: 'aa-8' }
    : /\bclogs?\b/i.test(t) ? { n: 'Clogs', cat: 'aa-8' }
    : /(heels?|pumps?)/i.test(t) ? { n: 'Heels', cat: 'aa-8-10' }
    : { n: 'Shoes', cat: 'aa-8' };
  const STYLE_RES = [['Platform', /\bplatform\b/i], ['Wedge', /\bwedges?\b/i], ['Block Heel', /\bblock\s*heel\b/i],
    ['Stiletto', /\bstiletto\b/i], ['Kitten Heel', /\bkitten\b/i], ['Low Heel', /\blow[-\s]?heel\b/i],
    ['Pointed Toe', /\bpointed(\s*toe)?\b/i], ['Almond Toe', /\balmond\s*toe\b/i], ['Round Toe', /\bround\s*toe\b/i],
    ['Square Toe', /\bsquare\s*toe\b/i], ['Open Toe', /\bopen\s*toe\b/i], ['Closed Toe', /\bclosed\s*toe\b/i],
    ['Cap Toe', /\bcap\s*toe\b/i], ['T-Bar', /\bt[-\s]?bar\b/i], ['T-Strap', /\bt[-\s]?strap\b/i],
    ['Slingback', /\bslingback\b/i], ['Ankle Strap', /\bankle[-\s]?strap\b/i], ['Cross Strap', /\bcross[-\s]?strap\b/i],
    ['Double Strap', /\bdouble[-\s]?strap\b/i], ['Adjustable Strap', /\badjustable[-\s]?strap\b/i],
    ['Strappy', /\bstrappy\b/i], ['Lace Up', /\blace[-\s]?up\b/i], ['Slip On', /\bslip[-\s]?on\b/i],
    ['Zip Up', /\bzip[-\s]?up\b/i], ['Buckle', /\bbuckle\b/i], ['Chain', /\bchain\b/i], ['Brogue', /\bbrogue\b/i],
    ['Tassel', /\btassel\b/i], ['Woven', /\bwoven\b/i], ['Braided', /\bbraided\b/i], ['Cutout', /\bcut[-\s]?out\b/i],
    ['Embroidered', /\bembroidered\b/i], ['Glitter', /\bglitter\b/i], ['Rhinestone', /\brhinestone\b/i],
    ['Bow', /\bbow\b/i], ['Chunky', /\bchunky\b/i], ['Knit', /\bknit\b/i], ['Ballet', /\bballet\b/i],
    ['Espadrille', /\bespadrilles?\b/i], ['Gladiator', /\bgladiator\b/i], ['Fisherman', /\bfisherman\b/i],
    ['Thong', /\bthong\b/i], ['Mule', /\bmules?\b/i], ['Slide', /\bslides?\b/i], ['Two Tone', /\btwo[-\s]?tone\b/i],
    ['Leather', /\bleather\b/i], ['Starfish', /\bstarfish\b/i], ['Arch Support', /\barch[-\s]?support\b/i],
    ['Cushioned', /\bcushion(ed)?\b/i], ['Sport', /\bsport\b/i], ['Athletic', /\bathletic\b/i],
    ['Running', /\brunning\b/i], ['Walking', /\bwalking\b/i], ['Low Top', /\blow[-\s]?top\b/i],
    ['Retro', /\bretro\b/i], ['Casual', /\bcasual\b/i], ['Comfort', /\bcomfort\b/i]];
  let styles = STYLE_RES.filter(([, re]) => re.test(t)).map(([c]) => c);
  // Drop a style word that already IS the garment noun (e.g. "Slide" for Slides,
  // "Mule" for Mules) so we don't get "Slide Slides".
  const baseSingular = base.n.toLowerCase().replace(/s$/, '');
  styles = styles.filter((s) => s.toLowerCase() !== baseSingular
    && !(base.n === 'Slides' && s === 'Slide') && !(base.n === 'Mules' && s === 'Mule')).slice(0, 2);
  const orth = /orthop(a)?edic/i.test(t);
  let noun = `${orth ? 'Orthopedic ' : ''}${styles.length ? styles.join(' ') + ' ' : ''}${base.n}`;
  noun = noun.replace(/Heel\s+Heels/i, 'Heels'); // "Block Heel Heels" -> "Block Heels"
  return { noun, cat: `gid://shopify/TaxonomyCategory/${base.cat}` };
}

// Women's EU -> US/CA shoe-size conversion (the store sells in CAD; US & CA
// women's sizes are numerically identical, so US/CA numbers are the house system).
const EU_TO_US_WOMENS = { 34: '4', 35: '5', 36: '5.5', 37: '6.5', 38: '7.5', 39: '8.5', 40: '9', 41: '10', 42: '11', 43: '12', 44: '13', 45: '14' };

/**
 * Normalize a scraped shoe size to a clean US/CA number: strip country labels
 * ("6US","6.5 US" -> "6","6.5"), take the lower bound of a range
 * ("5.5 – 6 US" -> "5.5"), and convert EU numbers (36–46) to US/CA. Non-numeric
 * (letter) sizes are returned trimmed as-is.
 */
function normalizeFootwearSize(v) {
  const raw = String(v ?? '').trim();
  const range = raw.match(/(\d{1,2}(?:\.\d)?)\s*[–-]\s*\d{1,2}(?:\.\d)?/);
  const num = range ? range[1] : (raw.match(/\d{1,2}(?:\.\d)?/) || [])[0];
  if (num == null) return raw; // letter size etc. — leave it
  const n = parseFloat(num);
  if (n >= 33 && n <= 46) return EU_TO_US_WOMENS[Math.round(n)] || String(n);
  return String(n); // already US/CA; drops trailing ".0" and the country label
}

/** Shorts garment-type noun with style baked in (style only when source says so). */
function detectShorts(text) {
  const t = String(text || '');
  const STYLE_RES = [['Denim', /\bdenim\b/i], ['High Waist', /\bhigh[-\s]?waist(ed)?\b/i], ['Cargo', /\bcargo\b/i],
    ['Bermuda', /\bbermuda\b/i], ['Linen', /\blinen\b/i], ['Paperbag', /\bpaper[-\s]?bag\b/i], ['Pleated', /\bpleated\b/i],
    ['Biker', /\bbiker\b/i], ['Drawstring', /\bdrawstring\b/i], ['Tailored', /\btailored\b/i], ['Athletic', /\bathletic\b/i]];
  const styles = STYLE_RES.filter(([, re]) => re.test(t)).map(([c]) => c).slice(0, 2);
  return `${styles.length ? styles.join(' ') + ' ' : ''}Shorts`;
}

/**
 * Pants garment-type noun with style baked in (style only when the source says
 * so — never invented). The base noun stays "Pants" unless the source clearly
 * names a different bottom (Leggings/Trousers/Culottes/Joggers/Palazzo).
 */
function detectPants(text) {
  const t = String(text || '');
  // Jeans are denim pants — keep the precise noun ("Jeans") so the title and the
  // GMC category (Pants > Jeans) are accurate.
  const noun = /\bjeans?\b/i.test(t) ? 'Jeans'
    : /\bleggings?\b/i.test(t) ? 'Leggings'
    : /\bculottes?\b/i.test(t) ? 'Culottes'
    : /\bjoggers?\b/i.test(t) ? 'Joggers'
    : /\bpalazzo\b/i.test(t) ? 'Palazzo Pants'
    : /\btrousers?\b/i.test(t) ? 'Trousers'
    : 'Pants';
  const STYLE_RES = [['Wide Leg', /\bwide[-\s]?leg\b/i], ['Straight Leg', /\bstraight[-\s]?leg\b/i],
    ['Barrel Leg', /\bbarrel[-\s]?leg\b/i], ['Bootcut', /\bboot[-\s]?cut\b/i], ['Skinny', /\bskinny\b/i],
    ['Flare', /\bflare(d)?\b/i], ['Tapered', /\btapered\b/i], ['Distressed', /\bdistressed\b/i],
    ['Cargo', /\bcargo\b/i], ['Pleated', /\bpleated\b/i], ['High Waist', /\bhigh[-\s]?waist(ed)?\b/i],
    ['Cropped', /\bcropped?\b/i], ['Paperbag', /\bpaper[-\s]?bag\b/i], ['Linen', /\blinen\b/i],
    ['Mom', /\bmom\b/i], ['Boyfriend', /\bboyfriend\b/i], ['Denim', /\bdenim\b/i],
    ['Drawstring', /\bdrawstring\b/i], ['Tailored', /\btailored\b/i], ['Capri', /\bcapri\b/i]];
  let styles = STYLE_RES.filter(([, re]) => re.test(t)).map(([c]) => c);
  // "Denim" is redundant once the noun is "Jeans"; drop any style already in the noun.
  styles = styles.filter((s) => !noun.toLowerCase().includes(s.toLowerCase()) && !(noun === 'Jeans' && s === 'Denim')).slice(0, 2);
  return `${styles.length ? styles.join(' ') + ' ' : ''}${noun}`;
}

/** Top garment-type noun from the source (honest; sleeve/neckline live in
 * attributes, so they're not baked here). Defaults to the generic "Top". */
function detectTop(text) {
  const t = String(text || '');
  // Knitwear first (so "sweatshirt" isn't read as "shirt", etc.).
  if (/\bsweat\s?shirt\b/i.test(t)) return 'Sweatshirt';
  if (/\bhoodie\b/i.test(t)) return 'Hoodie';
  if (/\bcardigan\b/i.test(t)) return 'Cardigan';
  if (/\bpullover\b/i.test(t)) return 'Pullover';
  if (/\b(sweater|jumper)\b/i.test(t)) return 'Sweater';
  if (/\bknit\b/i.test(t)) return 'Knit Top';
  if (/\bbody[-\s]?suit\b/i.test(t)) return 'Bodysuit';
  if (/\bcami(?:sole)?\b/i.test(t)) return 'Camisole';
  if (/\btank\b/i.test(t)) return 'Tank Top';
  if (/\btunic\b/i.test(t)) return 'Tunic';
  if (/\bpeplum\b/i.test(t)) return 'Peplum Top';
  if (/\bcrop\s*top\b/i.test(t)) return 'Crop Top';
  if (/\b(t[-\s]?shirt|tee)\b/i.test(t)) return 'T-Shirt';
  if (/\bblouse\b/i.test(t)) return 'Blouse';
  if (/\bshirt\b/i.test(t)) return 'Shirt';
  return 'Top';
}

/** Skirt garment-type noun with style baked in (style only when source says so).
 * Maxi/Midi/Mini here are skirt STYLES baked into the noun, not a dress length. */
function detectSkirt(text) {
  const t = String(text || '');
  const STYLE_RES = [['Maxi', /\bmaxi\b/i], ['Midi', /\bmidi\b/i], ['Mini', /\bmini\b/i],
    ['Pleated', /\bpleated\b/i], ['A-Line', /\ba[-\s]?line\b/i], ['Wrap', /\bwrap\b/i],
    ['Pencil', /\bpencil\b/i], ['Tiered', /\btiered\b/i], ['Ruffle', /\bruffle(d)?\b/i],
    ['Denim', /\bdenim\b/i], ['Satin', /\bsatin\b/i], ['Linen', /\blinen\b/i], ['Cargo', /\bcargo\b/i],
    ['Asymmetric', /\basymmetric(al)?\b/i], ['High Waist', /\bhigh[-\s]?waist(ed)?\b/i]];
  const styles = STYLE_RES.filter(([, re]) => re.test(t)).map(([c]) => c).slice(0, 2);
  return `${styles.length ? styles.join(' ') + ' ' : ''}Skirt`;
}

// Honest occasion tags for the custom.occasion metafield (internal filtering).
// Only genuine source signals — never inferred/bulk-applied (GMC guardrail).
const OCCASION_TAG_RES = [['wedding guest', /\bwedding\s*guest\b/i], ['wedding', /\bwedding\b/i], ['bridesmaid', /\bbridesmaid\b/i],
  ['bridal', /\bbridal\b/i], ['cocktail', /\bcocktail\b/i], ['formal', /\bformal\b/i], ['evening', /\bevening\b/i],
  ['prom', /\bprom\b/i], ['party', /\bparty\b/i], ['homecoming', /\bhomecoming\b/i], ['vacation', /\b(vacation|holiday|resort)\b/i],
  ['beach', /\bbeach\b/i], ['brunch', /\bbrunch\b/i], ['work', /\b(work|office|business)\b/i], ['casual', /\bcasual\b/i]];
function detectOccasionTags(text) {
  const t = String(text || '');
  return OCCASION_TAG_RES.filter(([, re]) => re.test(t)).map(([c]) => c);
}

/** Title-case a free color label we keep verbatim (unknown-but-real colors). */
function cleanColorLabel(s) {
  return stripStockSuffix(s).replace(/\s+/g, ' ').split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function uniq(values) {
  const seen = new Set(); const out = [];
  for (const v of values) { const s = String(v).trim(); const k = s.toLowerCase(); if (s && !seen.has(k)) { seen.add(k); out.push(s); } }
  return out;
}

function firstMatch(haystack, candidates) {
  const t = String(haystack || '');
  for (const c of candidates) if (new RegExp(`\\b${c.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(t)) return c.replace('-Neck', ' Neck');
  return null;
}

/** Classify option slots: which slot is sizes vs colors, from variant option values. */
function classifyOptions(variants) {
  const slots = [[], [], []];
  for (const v of variants) [v.option1, v.option2, v.option3].forEach((val, i) => { if (val != null && val !== '') slots[i].push(val); });
  const vals = slots.map(uniq);
  let sizeIdx = -1, colorIdx = -1;
  vals.forEach((vv, i) => {
    if (vv.length === 0) return;
    const sizeRatio = vv.filter((x) => SIZE_RE.test(String(x).trim())).length / vv.length;
    if (sizeRatio >= 0.6 && sizeIdx === -1) sizeIdx = i;
  });
  vals.forEach((vv, i) => { if (vv.length && i !== sizeIdx && colorIdx === -1) colorIdx = i; });
  return {
    colors: colorIdx >= 0 ? vals[colorIdx] : [],
    sizes: sizeIdx >= 0 ? vals[sizeIdx] : [],
    colorIdx, sizeIdx,
  };
}

/**
 * Build per-color image list from an authoritative Shopify product (products.json),
 * which carries images[].variant_ids and variants[].option* — enabling each image
 * to be tagged with its color (spec §9.1/§14.2).
 */
function imagesFromLinkage(linkage) {
  const options = linkage.options || [];
  const colorOpt = options.find((o) => /colou?r/i.test(o?.name || ''));
  const colorPos = colorOpt?.position || 1; // 1-based option index
  const variantColor = new Map();
  for (const v of linkage.variants || []) variantColor.set(v.id, v[`option${colorPos}`]);

  const imgs = (linkage.images || []).slice().sort((a, b) => (a.position ?? 1) - (b.position ?? 1));
  return imgs.map((im, i) => {
    const colorsForImg = new Set((im.variant_ids || []).map((id) => variantColor.get(id)).filter(Boolean));
    const color = colorsForImg.size === 1 ? stripStockSuffix([...colorsForImg][0]) : null; // one color -> tag it; else gallery
    return {
      src: im.src,
      position: im.position ?? i + 1,
      ...(color ? { color } : {}),
      ...(i === 0 ? { main: true } : {}),
    };
  }).filter((im) => /^https?:\/\//.test(im.src || ''));
}

export function mapApifyToInput(raw, opts = {}) {
  const { sourceCurrency, group, referenceUrl, trustImages = false, lengthContext, sleeveContext, occasionTags } = opts;
  const notes = [];
  const variants = Array.isArray(raw.variants) ? raw.variants : [];

  const tagStr = Array.isArray(raw.tags) ? raw.tags.join(' ') : String(raw.tags || '');
  const typeStr = raw.product_type || raw.productType || '';
  const isDress = /\bdress(es)?\b/i.test(raw.title || '') ||
    /\bdress(es)?\b/i.test(tagStr) ||
    /dress/i.test(typeStr) ||
    /\bgowns?\b/i.test(`${raw.title || ''} ${tagStr} ${typeStr}`); // a gown is a dress
  // Swimwear takes precedence over sets (a bikini is a "set" but is swimwear).
  const swimText = `${raw.title || ''} ${tagStr} ${typeStr}`;
  const isSwim = !isDress && /\b(bikini|tankini|one[-\s]?piece|swimsuit|swimwear|bathing\s*suit|monokini)\b/i.test(swimText);
  // Footwear (sandals/heels/sneakers/…) — its own category + title rules.
  const isFootwear = !isDress && !isSwim &&
    /\b(sandals?|shoes?|sneakers?|trainers?|boots?|heels?|pumps?|wedges?|espadrilles?|mules?|loafers?|flip[-\s]?flops?|slides?|sliders?|clogs?|flats|ballet|mary\s*jane|slingbacks?)\b/i.test(`${raw.title || ''} ${typeStr}`);
  // Two-piece outfits / rompers / jumpsuits — classified as sets (never dresses/swim/footwear).
  const isSet = !isDress && !isSwim && !isFootwear &&
    (/\b(sets?|two[-\s]?piece|romper|jumpsuit|co[-\s]?ord)\b/i.test(raw.title || '') ||
     /\b(sets?|two[-\s]?piece|co[-\s]?ord)\b/i.test(tagStr));
  const otherText = `${raw.title || ''} ${typeStr}`;
  // "shorts" (plural garment) only — must NOT match "short sleeve".
  const isShorts = !isDress && !isSwim && !isFootwear && !isSet && /\bshorts\b/i.test(otherText);
  // Bottoms: pants/trousers/leggings/etc. and skirts — their own Bottoms taxonomy
  // nodes (never aa-1-4), no dress length, garment-type noun stands in the title.
  const isPants = !isDress && !isSwim && !isFootwear && !isSet && !isShorts &&
    /\b(pants?|trousers?|leggings?|culottes?|joggers?|palazzo|jeans?)\b/i.test(otherText);
  const isSkirt = !isDress && !isSwim && !isFootwear && !isSet && !isShorts && !isPants &&
    /\bskirts?\b/i.test(otherText);
  const isTop = !isDress && !isSwim && !isFootwear && !isSet && !isShorts && !isPants && !isSkirt &&
    /\b(blouse|shirt|sweat\s?shirt|sweater|pullover|jumper|cardigan|hoodie|knit|tops?|tee|t[-\s]?shirt|tank|cami(?:sole)?|tunic|peplum|bodysuit|crop\s*top)\b/i.test(otherText);
  const swim = isSwim ? detectSwimType(`${raw.title || ''} ${typeStr}`) : null;
  const foot = isFootwear ? detectFootwear(`${raw.title || ''} ${typeStr} ${tagStr}`) : null;
  const productType = isDress ? 'Dress'
    : isSwim ? swim.noun
    : isFootwear ? foot.noun
    : isSet ? detectSetType(raw.title)
    : isShorts ? detectShorts(otherText)
    : isPants ? detectPants(otherText)
    : isSkirt ? detectSkirt(otherText)
    : isTop ? detectTop(otherText)
    : (raw.productType || (Array.isArray(raw.tags) ? raw.tags[0] : undefined) || 'Product');

  // Options from variants (this actor has no top-level options array).
  const cls = classifyOptions(variants);

  // Read REAL colors from the source — never drop a colorway (that would lose a
  // variant). Recognized colors are normalized; recognized patterns (Floral,
  // Polka Dot, Camouflage, …) keep their source label AND are tracked so the
  // feed can carry a pattern attribute + inferred base color; anything else
  // (e.g. "Peacock Blue") is kept verbatim as a storefront color label.
  const keptColors = [];
  const patternsFound = [];
  for (const c of cls.colors) {
    const norm = normalizeColorName(c);
    if (norm) { keptColors.push(norm); continue; }
    const pat = normalizePattern(c);
    if (pat) { keptColors.push(cleanColorLabel(c)); patternsFound.push(pat); continue; }
    keptColors.push(cleanColorLabel(c));
  }
  let colors = uniq(keptColors);
  const patterns = uniq(patternsFound);
  // Footwear: normalize scraped shoe sizes to clean US/CA numbers (strip "US"
  // labels, lower-bound of ranges, EU->US/CA) for one consistent system.
  let sizes = isFootwear ? uniq(cls.sizes.map(normalizeFootwearSize)) : cls.sizes;
  if (colors.length === 0) { colors = ['Default']; notes.push('No color option detected; defaulted to "Default".'); }
  if (sizes.length === 0) { sizes = ['One Size']; notes.push('No size option detected; defaulted to "One Size".'); }

  // Prices.
  const priceOf = (v) => parseFloat(v.price);
  const prices = variants.map(priceOf).filter((n) => Number.isFinite(n) && n > 0);
  const topPrice = parseFloat(raw.price);
  const sourcePrice = prices.length ? Math.min(...prices) : (Number.isFinite(topPrice) ? topPrice : NaN);
  if (!Number.isFinite(sourcePrice) || sourcePrice <= 0) {
    throw new Error('mapApifyToInput: could not derive a positive sourcePrice.');
  }

  // Per-variant price overrides (preserve real per-combo SOURCE prices). These
  // are raw supplier cost; the FINAL selling price for every variant is charm-
  // snapped (ends in 4.95/9.95) downstream by pricing.sellingPrice -> charmPrice,
  // applied after FX + markup in buildVariants. Do NOT charm-snap source cost here.
  const variantOverrides = [];
  if (cls.colorIdx >= 0 && cls.sizeIdx >= 0) {
    const colorKey = `option${cls.colorIdx + 1}`, sizeKey = `option${cls.sizeIdx + 1}`;
    const colorSet = new Set(colors.map((c) => c.toLowerCase()));
    const sizeSet = new Set(sizes.map((s) => s.toLowerCase()));
    for (const v of variants) {
      const c = stripStockSuffix(v[colorKey]), s = isFootwear ? normalizeFootwearSize(v[sizeKey]) : v[sizeKey], p = priceOf(v);
      if (c && s && Number.isFinite(p) && p > 0 &&
          colorSet.has(String(c).toLowerCase()) && sizeSet.has(String(s).toLowerCase())) {
        variantOverrides.push({ color: String(c).trim(), size: String(s).trim(), sourcePrice: p });
      }
    }
  }

  // Attributes parsed from the title (+ occasion from tags). Only when present.
  // Skipped for footwear — its descriptors (style/orthopedic) live in productType,
  // and clothing attributes (neckline/silhouette/length) don't apply to shoes.
  const attributes = {};
  let occasion = null;
  if (!isFootwear && !isShorts && !isPants && !isSkirt) {
    // Length inference from the source title (spec §5.1/§12). If none is found the
    // title builder fails the product downstream — a length is never omitted.
    const length = detectLength(raw.title) ||
      (isDress ? detectLength(`${tagStr} ${raw.productType || raw.product_type || ''}`) : null) ||
      (isDress ? lengthContext : null); // sub-collection length when the source omits it
    if (length && !isTop) attributes.length = length; // tops never carry a dress length
    const neckline = firstMatch(raw.title, NECKLINES); if (neckline) attributes.neckline = neckline;
    // Sleeve from the title; for tops, fall back to the sub-collection's sleeve
    // (e.g. the "Long Sleeve Tops" source) when the title doesn't state one.
    const sleeve = firstMatch(raw.title, SLEEVES) || (isTop ? sleeveContext : null);
    if (sleeve) attributes.sleeve = sleeve;
    const silhouette = firstMatch(raw.title, SILHOUETTES); if (silhouette) attributes.silhouette = silhouette;
    const tagText = (raw.tags || []).join(' ') + ' ' + (raw.title || '');
    occasion = (() => { for (const [n, o] of OCCASIONS) if (new RegExp(`\\b${n}\\b`, 'i').test(tagText)) return o; return null; })();
    if (occasion) attributes.occasion = occasion;
  }

  const currency = sourceCurrency || (/^(CAD|USD)$/i.test(raw.currency || '') ? raw.currency.toUpperCase() : 'CAD');

  const input = {
    sourceCurrency: currency,
    sourcePrice,
    productType,
    isDress,
    group: group || (occasion && isDress ? `${occasion} Dresses` : (isDress ? 'Dresses' : productType)),
    colors,
    sizes,
  };
  if (isSet) input.isSet = true;
  if (isSwim) { input.isSwim = true; input.swimCategoryId = swim.cat; }
  if (isFootwear) { input.isFootwear = true; input.footwearCategoryId = foot.cat; }
  if (isShorts) input.isShorts = true;
  if (isPants) { input.isPants = true; if (/\bjeans?\b/i.test(otherText)) input.pantsCategoryId = 'gid://shopify/TaxonomyCategory/aa-1-12-4'; }
  if (isSkirt) input.isSkirt = true;
  if (isTop) {
    input.isTop = true;
    // Route knitwear to its precise GMC node; generic tops use the Blouses node.
    const tc = /sweater|pullover|jumper/i.test(productType) ? 'aa-1-13-12'
      : /cardigan/i.test(productType) ? 'aa-1-13-3'
      : /hoodie/i.test(productType) ? 'aa-1-13-13'
      : /sweatshirt/i.test(productType) ? 'aa-1-13-14'
      : null;
    if (tc) input.topCategoryId = `gid://shopify/TaxonomyCategory/${tc}`;
  }
  // Honest occasion tags (caller context + source title/tags) for custom.occasion.
  const occTags = uniq([...(occasionTags || []), ...detectOccasionTags(`${raw.title || ''} ${tagStr}`)]);
  if (occTags.length) input.occasionTags = occTags;
  if (Object.keys(attributes).length) input.attributes = attributes;
  if (variantOverrides.length) input.variantOverrides = variantOverrides;

  // Pattern handling: a print kept as a storefront color also feeds GMC `pattern`.
  // When the option is ENTIRELY pattern(s) (no real color), infer a base color
  // for the GMC `color` attribute so the feed isn't "Floral".
  if (patterns.length) {
    input.pattern = patterns.join(' / ');
    const hasRealColor = colors.some((c) => normalizeColorName(c));
    if (!hasRealColor) {
      const tagStr = Array.isArray(raw.tags) ? raw.tags.join(' ') : String(raw.tags || '');
      input.feedColor = inferBaseColor(`${raw.title || ''} ${tagStr} ${raw.body_html || ''}`);
      notes.push(`Pattern-only color (${input.pattern}); storefront keeps the pattern label, feed color inferred as "${input.feedColor}".`);
      // Single-print style (every colorway is the same print): put the print in
      // the title (e.g. "Camouflage Bikini Set", "Leopard Print Loafers"). Never
      // when prints mix with solids (GMC misrepresentation risk) — hasRealColor branch.
      if ((isSwim || isFootwear) && patterns.length === 1) input.productType = `${patterns[0]} ${input.productType}`;
    } else {
      notes.push(`Pattern value(s) ${input.pattern} kept as variant(s) alongside real colors; feed pattern set.`);
    }
  }

  const url = referenceUrl || raw.url;
  if (url && /^https?:\/\//.test(url)) input.referenceUrl = url;
  if (currency !== 'CAD') notes.push(`sourceCurrency=${currency}; verify FX before pricing (spec §13).`);

  // Images — quarantined by default (spec §9.3/§17).
  const scraped = (raw.images || [])
    .map((im, i) => ({ src: im.src || im.url || im, position: im.position ?? i + 1 }))
    .filter((im) => typeof im.src === 'string' && /^https?:\/\//.test(im.src));
  let unverifiedImages = [];
  if (trustImages && opts.linkage) {
    // Preferred: per-color images from authoritative source linkage (§9.1/§14.2).
    input.images = imagesFromLinkage(opts.linkage);
    const mapped = input.images.filter((im) => im.color).length;
    notes.push(`trustImages=true: ${input.images.length} image(s) from source linkage, ${mapped} color-tagged (spec §9.1/§14.2).`);
  } else if (trustImages && scraped.length) {
    input.images = scraped.map((im, i) => ({ ...im, ...(i === 0 ? { main: true } : {}) }));
    notes.push('trustImages=true: gallery images only (no per-color linkage available); confirm rights (spec §9.3/§17).');
  } else if (scraped.length) {
    unverifiedImages = scraped;
    notes.push(`${scraped.length} scraped image(s) QUARANTINED (not in images[]). Use trustImages:true only if licensed/owned/approved (spec §9.3/§17).`);
  }

  // Reconcile image color tags with the kept color options: normalize casing to
  // the chosen color, and drop the tag for any color that was filtered out (e.g.
  // a "Dots" pattern) so the image survives as a gallery image instead of an
  // orphaned color reference that would fail input validation.
  if (Array.isArray(input.images)) {
    const colorByLower = new Map(colors.map((c) => [c.toLowerCase(), c]));
    let untagged = 0;
    input.images = input.images.map((im) => {
      if (im.color == null) return im;
      const canon = colorByLower.get(String(normalizeColorName(im.color) || stripStockSuffix(im.color)).toLowerCase());
      if (canon) return { ...im, color: canon };
      const { color, ...rest } = im; // dropped color -> keep as gallery image
      untagged++;
      return rest;
    });
    if (untagged) notes.push(`${untagged} image(s) had a non-color/dropped tag removed (kept as gallery image).`);
  }

  return { input, unverifiedImages, notes };
}

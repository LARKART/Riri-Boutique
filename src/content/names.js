/**
 * Brand-style product-name allocation (spec §5.2, §14.3).
 *
 * Names are decided UP FRONT — before copy generation and before SKU/title
 * construction — so a single authoritative name flows into the title, the SKU
 * (RIRI-[NAME]-…), and every copy field. This removes the old post-build
 * "dedupe + rename" step that desynced SKUs/copy from the title.
 *
 * Allocation is deterministic and batch-unique: take a preferred name if free,
 * otherwise the next free pool name, otherwise a synthesized brand-style name.
 */

'use strict';

import { EXTRA_NAMES } from './name-pool-extended.js';

/** Curated brand-style pool. Extend freely; the synthesizer covers overflow. */
const BASE_POOL = [
  // Original set.
  'Serane', 'Elowen', 'Marielle', 'Avora', 'Celina', 'Evadra', 'Lirelle', 'Noemi',
  'Calla', 'Vesper', 'Ondine', 'Amaris', 'Sorrel', 'Thalia', 'Maren', 'Linnea',
  'Cosette', 'Delphine', 'Isolde', 'Rhea', 'Mirabel', 'Yvaine', 'Solene', 'Anouk',
  'Verena', 'Avelline', 'Maevelle', 'Calienne', 'Verelle', 'Avorelle', 'Vesperly',
  'Sabine', 'Elise', 'Romy', 'Odette', 'Margaux', 'Colette', 'Lucienne', 'Aveline',
  // Widened set — elegant women's first names so new products get real-sounding,
  // unique names (no numbered synthesis) even with a large store already reserved.
  'Lysandra', 'Sloane', 'Seraphine', 'Vivienne', 'Genevieve', 'Ottoline', 'Rosalind',
  'Clementine', 'Arabella', 'Cordelia', 'Evangeline', 'Florentine', 'Hermione',
  'Isadora', 'Josephine', 'Katarina', 'Leonora', 'Marguerite', 'Nicolette', 'Octavia',
  'Persephone', 'Rosamund', 'Seraphina', 'Theodora', 'Valentina', 'Wilhelmina',
  'Ximena', 'Yolanda', 'Zinnia', 'Adeline', 'Bellamy', 'Camille', 'Daphne', 'Eloise',
  'Fleur', 'Giselle', 'Helene', 'Iris', 'Juliette', 'Coralie', 'Liliane', 'Manon',
  'Noelle', 'Oceane', 'Pauline', 'Sylvie', 'Therese', 'Ursule', 'Violette', 'Capucine',
  'Amandine', 'Bernadette', 'Charlotte', 'Delphina', 'Emmeline', 'Faustine', 'Ghislaine',
  'Honorine', 'Ines', 'Jacqueline', 'Leonie', 'Mathilde', 'Ninon', 'Ombeline',
  'Philippine', 'Rosalie', 'Salome', 'Tiphaine', 'Apolline', 'Blandine', 'Clarisse',
  'Domitille', 'Eugenie', 'Sidonie', 'Albane', 'Berenice', 'Astrid', 'Beatrix', 'Clio',
  'Dahlia', 'Edith', 'Freya', 'Greer', 'Hazel', 'Imogen', 'Juno', 'Lark', 'Maeve',
  'Nova', 'Opal', 'Pearl', 'Quinn', 'Saffron', 'Tamsin', 'Verity', 'Wren', 'Briony',
  'Esme', 'Flora', 'Cleo', 'Saoirse', 'Niamh', 'Orla', 'Sinead', 'Aoife', 'Maelys',
  'Sienna', 'Elara', 'Lyra', 'Selene', 'Calliope', 'Thessaly', 'Ariadne', 'Cassia',
  'Delia', 'Eulalia', 'Ianthe', 'Lavinia', 'Ottilie', 'Rosaline', 'Sabella', 'Tindra',
  'Amelie', 'Brigitte', 'Celestine', 'Donatella', 'Elodie', 'Francine', 'Gwendolyn',
  'Heloise', 'Ilaria', 'Joelle', 'Karenza', 'Lisette', 'Mireille', 'Nerissa', 'Oriane',
  'Primrose', 'Reverie', 'Susannah', 'Tatiana', 'Ursula', 'Vespera', 'Willa', 'Zelda',
  'Anaelle', 'Bastienne', 'Cosima', 'Dorothea', 'Emelina', 'Felicienne', 'Galatea',
  'Hyacinth', 'Isaline', 'Jessamine', 'Leontine', 'Magdalene', 'Noeline', 'Oceania',
  'Pomeline', 'Rosanna', 'Severine', 'Apollina', 'Vianne', 'Albertine', 'Cunera',
];

/** Full real-name pool: curated base + extended set, deduplicated (case-insensitive). */
export const NAME_POOL = (() => {
  const seen = new Set(); const out = [];
  for (const n of [...BASE_POOL, ...EXTRA_NAMES]) {
    const k = String(n).trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); out.push(String(n).trim()); }
  }
  return out;
})();

const SYNTH_PREFIXES = ['Av', 'Ser', 'Mar', 'Cel', 'Ev', 'Lir', 'No', 'Cal', 'Ves', 'Ond',
  'Am', 'Sor', 'Tha', 'Lin', 'Cos', 'Del', 'Iso', 'Rhe', 'Mir', 'Sol',
  'Ad', 'Ly', 'Sab', 'Vi', 'Rom', 'Od', 'Col', 'Luc', 'Bri', 'Es',
  'Ari', 'Na', 'Per', 'Sen', 'Ros', 'El', 'Cla', 'Fel', 'Gen', 'Hel',
  'Ire', 'Jul', 'Lor', 'Mae', 'Nor', 'Ophe', 'Ren', 'Syl', 'Tess', 'Val',
  'Wil', 'Yse', 'Zel', 'Ana', 'Cor', 'Dor', 'Eme', 'Flo', 'Gis', 'Lis'];
const SYNTH_SUFFIXES = ['elle', 'ine', 'ora', 'ina', 'enne', 'aris', 'ela', 'ette', 'ana', 'een',
  'etta', 'elia', 'iane', 'ienne', 'lyn', 'sande', 'rine', 'lise', 'wen', 'ssa',
  'ique', 'eline', 'antha', 'andra', 'essa', 'olene', 'avine', 'overa', 'iana', 'oise'];

/**
 * Deterministically synthesize a brand-style name for index i. UNBOUNDED: after
 * the prefix×suffix combos are exhausted it appends an incrementing number, so a
 * fresh unique name always exists no matter how large the store grows (otherwise
 * the allocator's "find a free name" loop can spin forever — a real bug once the
 * store outgrows the base combos).
 */
function synthesize(i) {
  const combos = SYNTH_PREFIXES.length * SYNTH_SUFFIXES.length;
  const p = SYNTH_PREFIXES[i % SYNTH_PREFIXES.length];
  const s = SYNTH_SUFFIXES[Math.floor(i / SYNTH_PREFIXES.length) % SYNTH_SUFFIXES.length];
  const round = Math.floor(i / combos); // 0 for the first pass, then 1, 2, …
  return `${p}${s}${round ? round + 1 : ''}`;
}

/**
 * Create a batch-scoped name allocator.
 * @param {string[]} [reserved] names already taken (case-insensitive)
 */
export function makeNameAllocator(reserved = []) {
  const used = new Set(reserved.map((n) => String(n).toLowerCase()));
  let poolIdx = 0;
  let synthIdx = 0;

  const free = (n) => n && !used.has(String(n).toLowerCase());
  const claim = (n) => { used.add(String(n).toLowerCase()); return n; };

  return {
    /** Is a name still available? */
    isFree: free,
    /**
     * Allocate a unique name. Honors `preferred` when free; otherwise pulls the
     * next free pool/synthesized name. Always returns a name not yet used.
     */
    take(preferred) {
      if (free(preferred)) return claim(String(preferred).trim());
      while (poolIdx < NAME_POOL.length) {
        const n = NAME_POOL[poolIdx++];
        if (free(n)) return claim(n);
      }
      let n;
      do { n = synthesize(synthIdx++); } while (!free(n));
      return claim(n);
    },
  };
}

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

/** Curated brand-style pool. Extend freely; the synthesizer covers overflow. */
export const NAME_POOL = [
  'Serane', 'Elowen', 'Marielle', 'Avora', 'Celina', 'Evadra', 'Lirelle', 'Noemi',
  'Calla', 'Vesper', 'Ondine', 'Amaris', 'Sorrel', 'Thalia', 'Maren', 'Linnea',
  'Cosette', 'Delphine', 'Isolde', 'Rhea', 'Mirabel', 'Yvaine', 'Solene', 'Anouk',
  'Verena', 'Avelline', 'Maevelle', 'Calienne', 'Verelle', 'Avorelle', 'Vesperly',
  'Sabine', 'Elise', 'Romy', 'Odette', 'Margaux', 'Colette', 'Lucienne', 'Aveline',
];

const SYNTH_PREFIXES = ['Av', 'Ser', 'Mar', 'Cel', 'Ev', 'Lir', 'No', 'Cal', 'Ves', 'Ond',
  'Am', 'Sor', 'Tha', 'Lin', 'Cos', 'Del', 'Iso', 'Rhe', 'Mir', 'Sol'];
const SYNTH_SUFFIXES = ['elle', 'ine', 'ora', 'ina', 'enne', 'aris', 'ela', 'ette', 'ana', 'een'];

/** Deterministically synthesize a brand-style name for index i. */
function synthesize(i) {
  const p = SYNTH_PREFIXES[i % SYNTH_PREFIXES.length];
  const s = SYNTH_SUFFIXES[Math.floor(i / SYNTH_PREFIXES.length) % SYNTH_SUFFIXES.length];
  return p + s;
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

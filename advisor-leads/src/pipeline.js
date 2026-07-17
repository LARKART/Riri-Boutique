// Run the free-first pipeline in sequence. Each stage is resumable/idempotent,
// so re-running continues where it left off (needed for the YouTube daily quota).
//
// Order per CLAUDE.md: Stage 0 (SEC IAPD seed) → Stage 1 (YouTube match) →
// Stage 2 (website contact crawl) → Stage 3 (gap enrichment + finalize) →
// Stage 4 (computed fields + CSV export).
//
// `npm run discover` (keyword search) remains available as a secondary source;
// its finds carry seedFirm=null and get IAPD-verified in Stage 3.
import { spawn } from 'node:child_process';

const stages = [
  'stage0-seed.js',
  'stage1-match.js',
  'stage2-enrich.js',
  'stage3-finalize.js',
  'stage4-export.js',
];

for (const stage of stages) {
  console.log(`\n=== ${stage} ===`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL(stage, import.meta.url).pathname], { stdio: 'inherit' });
    p.on('exit', resolve);
  });
  if (code !== 0) {
    console.error(`${stage} exited with code ${code} — fix and re-run (progress is saved).`);
    process.exit(code);
  }
}

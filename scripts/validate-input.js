/**
 * CLI gate: validate one or more product-input JSON files before transformation.
 *   node scripts/validate-input.js examples/serane.json [more.json ...]
 * Exits non-zero if any file has errors (spec 14.4).
 */

'use strict';

import { readFileSync } from 'node:fs';
import { validateProductInput } from '../src/validate/input.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/validate-input.js <file.json> [...]');
  process.exit(2);
}

let hadErrors = false;

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.log(`  ❌ Could not read/parse: ${err.message}`);
    hadErrors = true;
    continue;
  }

  const { valid, errors, warnings } = validateProductInput(data);
  for (const e of errors) console.log(`  ❌ ERROR:   ${e}`);
  for (const w of warnings) console.log(`  ⚠️  WARNING: ${w}`);
  if (valid && warnings.length === 0) console.log('  ✅ Clean — ready for transformation.');
  else if (valid) console.log(`  ✅ Valid (${warnings.length} warning(s)) — ready for transformation.`);
  else console.log(`  ⛔ Invalid (${errors.length} error(s)) — blocked from transformation.`);

  if (!valid) hadErrors = true;
}

console.log('');
process.exit(hadErrors ? 1 : 0);

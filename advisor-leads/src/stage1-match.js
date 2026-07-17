// Stage 1 (seed mode) — Match SEC-seeded firms to YouTube channels.
// For each Stage 0 firm, searches YouTube by firm name and accepts a channel
// only when the title strongly matches the firm name; then applies the same
// qualification filters as discovery mode. Records carry `seedFirm` so
// downstream stages know legitimacy is already verified via SEC IAPD.
//
// Quota note: search.list costs 100 units/firm → ~90 firms/day on the free
// tier. The script processes firms in stable order and resumes where it left
// off (data/stage1-match-progress.jsonl), so run it daily.
//
// Output: appends to data/stage1-channels.jsonl (shared with discovery mode).

import { searchChannels, getChannels, quota } from './youtube.js';
import { qualifyChannel, nameMatchScore } from './channel.js';
import { readJsonl, appendJsonl, logRun } from './util.js';

const MIN_MATCH = 0.7;

const firms = await readJsonl('stage0-firms.jsonl');
if (!firms.length) {
  console.error('No data/stage0-firms.jsonl — run stage0-seed.js first.');
  process.exit(1);
}
const tried = new Set((await readJsonl('stage1-match-progress.jsonl')).map((r) => r.firmKey));
const kept = new Set((await readJsonl('stage1-channels.jsonl')).map((c) => c.channelId));
console.log(`${firms.length} seeded firms; ${tried.size} already searched; ${kept.size} channels kept so far`);

for (const firm of firms) {
  const firmKey = firm.crd || `${firm.name}|${firm.state}`;
  if (tried.has(firmKey)) continue;
  if (quota.used > 9000) {
    console.log('Approaching daily quota — stopping. Re-run tomorrow to resume.');
    break;
  }

  let outcome = 'no match';
  try {
    const { channelIds } = await searchChannels(firm.name);
    const candidates = channelIds.length ? await getChannels(channelIds.slice(0, 10)) : [];
    for (const ch of candidates) {
      const score = nameMatchScore(firm.name, ch.snippet?.title || '');
      if (score < MIN_MATCH) continue;
      if (kept.has(ch.id)) { outcome = 'already kept'; break; }
      const { record, reason } = await qualifyChannel(ch);
      if (!record) { outcome = `matched but disqualified: ${reason}`; continue; }
      kept.add(record.channelId);
      await appendJsonl('stage1-channels.jsonl', {
        ...record,
        seedFirm: {
          name: firm.name,
          crd: firm.crd,
          city: firm.city,
          state: firm.state,
          website: firm.website,
          matchScore: Number(score.toFixed(2)),
        },
      });
      outcome = `KEPT (${record.subscriberCount} subs, score ${score.toFixed(2)})`;
      break; // one channel per firm
    }
  } catch (err) {
    outcome = `error: ${err.message}`;
  }
  tried.add(firmKey);
  await appendJsonl('stage1-match-progress.jsonl', { firmKey, firm: firm.name, outcome });
  if (outcome.startsWith('KEPT')) console.log(`+ ${firm.name} → ${outcome}`);
}

await logRun('stage1-match', { firmsSearchedTotal: tried.size, keptTotal: kept.size, quotaUsed: quota.used - quota.startOfRun });
console.log(`Done for today: ~${quota.used} quota units used, ${kept.size} total channels in stage1-channels.jsonl`);

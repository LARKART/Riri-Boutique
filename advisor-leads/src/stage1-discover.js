// Stage 1 — Discovery & channel stats via YouTube Data API v3 (free).
// Filters: subs 1–25k, upload within RECENCY_DAYS, US signal, practice keywords.
// Output: data/stage1-channels.jsonl (one qualifying channel per line).

import { config, SEARCH_QUERIES } from './config.js';
import { searchChannels, getChannels, quota } from './youtube.js';
import { qualifyChannel } from './channel.js';
import { readJsonl, appendJsonl, dataPath, logRun } from './util.js';

const seen = new Set((await readJsonl('stage1-channels.jsonl')).map((c) => c.channelId));
const rejected = new Set((await readJsonl('stage1-rejected.jsonl')).map((c) => c.channelId));
console.log(`Resuming: ${seen.size} kept, ${rejected.size} rejected so far`);

for (const query of SEARCH_QUERIES) {
  let pageToken = null;
  for (let page = 0; page < config.maxSearchPagesPerQuery; page++) {
    if (quota.used > 9000) {
      console.log('Approaching daily quota — stopping. Re-run tomorrow to resume.');
      process.exit(0);
    }
    let result;
    try {
      result = await searchChannels(query, pageToken);
    } catch (err) {
      console.error(`search failed for "${query}": ${err.message}`);
      break;
    }
    const fresh = result.channelIds.filter((id) => !seen.has(id) && !rejected.has(id));
    if (fresh.length) await processChannels(fresh);
    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }
  console.log(`[${query}] done — quota used ~${quota.used} units, kept total ${seen.size}`);
}

await logRun('stage1-discover', { keptTotal: seen.size, quotaUsed: quota.used - quota.startOfRun });
console.log(`Stage 1 complete: ${seen.size} qualifying channels in ${dataPath('stage1-channels.jsonl')}`);

async function processChannels(channelIds) {
  const channels = await getChannels(channelIds);
  for (const ch of channels) {
    const { record, reason } = await qualifyChannel(ch);
    if (!record) {
      rejected.add(ch.id);
      await appendJsonl('stage1-rejected.jsonl', { channelId: ch.id, title: ch.snippet?.title, reason });
      continue;
    }
    seen.add(record.channelId);
    // Discovery-mode records have no seedFirm — Stage 3 must IAPD-verify them.
    await appendJsonl('stage1-channels.jsonl', { ...record, seedFirm: null });
    console.log(`  + ${record.title} (${record.subscriberCount} subs, last ${record.lastUploadDate})`);
  }
}

import { config } from './config.js';
import { fetchJson } from './util.js';

const BASE = 'https://www.googleapis.com/youtube/v3';

// Rough quota accounting so runs stay inside the free 10k units/day.
// Seeded from logs/runs.jsonl so multiple processes in one day (match, then
// discover) share a single daily budget instead of each starting from zero.
// Note: YouTube quota resets at midnight Pacific time; we approximate that day
// boundary in UTC-7.
export const quota = { used: 0 };
try {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('../logs/runs.jsonl', import.meta.url), 'utf8');
  const ptDay = (iso) => new Date(new Date(iso).getTime() - 7 * 3600000).toISOString().slice(0, 10);
  const today = ptDay(new Date().toISOString());
  for (const line of text.split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.quotaUsed && ptDay(r.at) === today) quota.used += r.quotaUsed;
  }
  if (quota.used) console.log(`(resuming with ~${quota.used} quota units already used today)`);
} catch { /* no log yet */ }
quota.startOfRun = quota.used; // stages log (used - startOfRun) so daily sums don't double-count

function key() {
  if (!config.youtubeApiKey) throw new Error('Set YOUTUBE_API_KEY in .env (free key from Google Cloud Console)');
  return config.youtubeApiKey;
}

async function yt(endpoint, params, cost) {
  const before = quota.used;
  quota.used += cost;
  // One-time warning as we approach the free daily limit (10,000 units).
  if (before <= 8000 && quota.used > 8000) {
    console.warn(`⚠ YouTube quota: ~${quota.used}/10000 units used this run — approaching the daily limit`);
  }
  const qs = new URLSearchParams({ ...params, key: key() });
  return fetchJson(`${BASE}/${endpoint}?${qs}`);
}

// search.list costs 100 units per page — the expensive call. Returns channel IDs.
export async function searchChannels(query, pageToken) {
  const data = await yt('search', {
    part: 'snippet',
    type: 'channel',
    q: query,
    regionCode: 'US',
    relevanceLanguage: 'en',
    maxResults: '50',
    ...(pageToken ? { pageToken } : {}),
  }, 100);
  return {
    channelIds: (data.items || []).map((i) => i.id.channelId).filter(Boolean),
    nextPageToken: data.nextPageToken || null,
  };
}

// channels.list costs 1 unit per call, up to 50 IDs.
export async function getChannels(channelIds) {
  const out = [];
  for (let i = 0; i < channelIds.length; i += 50) {
    const batch = channelIds.slice(i, i + 50);
    const data = await yt('channels', {
      part: 'snippet,statistics,contentDetails,brandingSettings',
      id: batch.join(','),
      maxResults: '50',
    }, 1);
    out.push(...(data.items || []));
  }
  return out;
}

// playlistItems.list costs 1 unit — recent uploads from the channel's uploads playlist.
export async function getRecentUploads(uploadsPlaylistId, max = 15) {
  try {
    const data = await yt('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(max, 50)),
    }, 1);
    return data.items || [];
  } catch {
    return []; // playlist can be missing/private
  }
}

// videos.list costs 1 unit per 50 — view counts for recent videos.
export async function getVideoStats(videoIds) {
  if (!videoIds.length) return [];
  const data = await yt('videos', {
    part: 'statistics,snippet',
    id: videoIds.slice(0, 50).join(','),
  }, 1);
  return data.items || [];
}

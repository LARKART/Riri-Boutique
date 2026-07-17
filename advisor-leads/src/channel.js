// Shared channel qualification: applies the target-profile filters and builds
// the canonical channel record used by both discovery and firm-matching.

import { config, PRACTICE_KEYWORDS, EXCLUDE_KEYWORDS } from './config.js';
import { getRecentUploads, getVideoStats } from './youtube.js';

// Returns { record } on success, { reason } when the channel is disqualified.
export async function qualifyChannel(ch) {
  const cutoff = Date.now() - config.recencyDays * 86400000;
  const stats = ch.statistics || {};
  const subs = Number(stats.subscriberCount || 0);
  const snippet = ch.snippet || {};
  const text = `${snippet.title} ${snippet.description || ''}`;

  if (stats.hiddenSubscriberCount) return { reason: 'hidden subs' };
  if (subs < config.subscriberMin || subs > config.subscriberMax) return { reason: `subs ${subs}` };
  if (snippet.country && snippet.country !== 'US') return { reason: `country ${snippet.country}` };
  if (EXCLUDE_KEYWORDS.test(text)) return { reason: 'excluded keywords' };
  if (!PRACTICE_KEYWORDS.test(text)) return { reason: 'no practice keywords' };

  const uploadsId = ch.contentDetails?.relatedPlaylists?.uploads;
  const uploads = uploadsId ? await getRecentUploads(uploadsId, 15) : [];
  const lastUpload = uploads[0]?.contentDetails?.videoPublishedAt || uploads[0]?.snippet?.publishedAt;
  if (!lastUpload || new Date(lastUpload).getTime() < cutoff) {
    return { reason: `stale (last: ${lastUpload || 'none'})` };
  }

  const recentIds = uploads.slice(0, 10).map((u) => u.contentDetails?.videoId).filter(Boolean);
  const videoStats = await getVideoStats(recentIds);
  const recentVideos = videoStats.map((v) => ({
    videoId: v.id,
    publishedAt: v.snippet?.publishedAt,
    viewCount: Number(v.statistics?.viewCount || 0),
  }));

  const uploadsLast60 = uploads.filter((u) => {
    const d = u.contentDetails?.videoPublishedAt || u.snippet?.publishedAt;
    return d && new Date(d).getTime() >= cutoff;
  }).length;

  return {
    record: {
      channelId: ch.id,
      channelUrl: snippet.customUrl
        ? `https://www.youtube.com/${snippet.customUrl}`
        : `https://www.youtube.com/channel/${ch.id}`,
      title: snippet.title,
      description: snippet.description || '',
      country: snippet.country || null,
      subscriberCount: subs,
      totalVideos: Number(stats.videoCount || 0),
      lastUploadDate: lastUpload.slice(0, 10),
      uploadsLast60Days: uploadsLast60,
      recentVideos,
      scrapedAt: new Date().toISOString().slice(0, 10),
    },
  };
}

// Token-overlap similarity between a firm name and a channel title, used to
// accept/reject a YouTube search hit as a match for a seeded firm.
const STOP = new Set(['llc', 'inc', 'the', 'of', 'and', 'group', 'co', 'lp', 'llp', 'pc', 'pllc', 'ltd', 'corp']);
export function nameMatchScore(firmName, channelTitle) {
  const tokens = (s) => new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t)),
  );
  const a = tokens(firmName);
  const b = tokens(channelTitle);
  if (!a.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size; // fraction of significant firm-name tokens present in the channel title
}

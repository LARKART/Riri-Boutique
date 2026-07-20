// Stage 2 — Email/contact enrichment (free: direct website crawling).
// Reads channel description links, finds the firm website, then crawls the
// homepage + contact/about pages for email, phone, LinkedIn, city/state.
// Every email carries an emailSource URL — never guessed.
// Output: data/stage2-enriched.jsonl

import { readJsonl, appendJsonl, fetchText, fetchJson, sleep, bumpMonthlyUsage } from './util.js';
import { CREDENTIAL_RE } from './config.js';

const channels = await readJsonl('stage1-channels.jsonl');
const done = new Set((await readJsonl('stage2-enriched.jsonl')).map((c) => c.channelId));
console.log(`${channels.length} channels; ${done.size} already enriched`);

// --- Optional pre-pass: Apify YouTube-channel email scraper (batched) ---
// Pulls email, social links, and website straight from each channel's About
// page. Emails from the channel About page satisfy the spec's sourcing rule.
const APIFY_BASE = process.env.APIFY_BASE_URL || 'https://api.apify.com';
const APIFY_TOKEN = process.env.APIFY_API_TOKEN || '';
const YT_ACTOR = process.env.APIFY_YT_EMAIL_ACTOR_ID || '';
const ytInfo = new Map(); // channelUrl (lowercased) -> actor item

if (APIFY_TOKEN && YT_ACTOR) {
  const pending = channels.filter((c) => !done.has(c.channelId));
  // Batches of 20 with actor concurrency 10 stay well inside the 300s
  // run-sync window (100-channel batches time out).
  const BATCH = 20;
  console.log(`Apify YT email scraper: querying ${pending.length} channels in batches of ${BATCH}`);
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    try {
      const items = await fetchJson(
        `${APIFY_BASE}/v2/acts/${encodeURIComponent(YT_ACTOR)}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=300`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // datascoutapi/youtube-channel-email-scraper input: handles or URLs.
          body: JSON.stringify({ handles: batch.map((c) => c.channelUrl), concurrency: 10 }),
        }, 1,
      );
      await bumpMonthlyUsage('apify_yt_channels', batch.length);
      for (const it of Array.isArray(items) ? items : []) {
        const key = (it.channelUrl || it.channel_url || it.url || it.input || '').toLowerCase().replace(/\/$/, '');
        if (key) ytInfo.set(key, it);
        // Also index by handle/channel id so URL-format differences still match.
        const id = it.channelId || it.channel_id || null;
        if (id) ytInfo.set(id, it);
        const handle = (it.handle || '').toLowerCase().replace(/^@/, '');
        if (handle) ytInfo.set(`https://www.youtube.com/@${handle}`, it);
      }
      console.log(`  batch ${i / 100 + 1}: ${Array.isArray(items) ? items.length : 0} results`);
    } catch (err) {
      console.warn(`  Apify YT batch failed: ${err.message.slice(0, 100)} — falling back to API-description data for these`);
      // Account-level hard limit: no point retrying further batches this run.
      if (/Monthly usage hard limit|platform-feature-disabled/i.test(err.message)) {
        console.warn('  Apify monthly usage limit reached — skipping remaining batches');
        break;
      }
    }
    await sleep(500);
  }
} else if (!APIFY_TOKEN) {
  console.log('APIFY_API_TOKEN not set — skipping YouTube About-page email scraping');
} else {
  console.log('APIFY_YT_EMAIL_ACTOR_ID not set — skipping YouTube About-page email scraping');
}

function ytLookup(ch) {
  return ytInfo.get(ch.channelUrl.toLowerCase().replace(/\/$/, '')) || ytInfo.get(ch.channelId) || null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const LINKEDIN_RE = /https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/[a-zA-Z0-9_%-]+/;
const CITY_STATE_RE = /([A-Z][a-zA-Z.\s]{2,25}),\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const JUNK_EMAIL = /\.(png|jpg|jpeg|gif|webp|svg)$|@(example|sentry|wixpress|godaddy|squarespace|2x)\b|noreply|no-reply|@youtube\.com/i;

const SOCIAL_HOSTS = /youtube\.com|youtu\.be|facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|linkedin\.com|linktr\.ee|calendly\.com|spotify\.com|apple\.com|patreon\.com|amazon\.com|bit\.ly/i;
// Job boards / review / directory aggregators sometimes appear in the SEC
// "website" field but are never the firm's own domain — skip them.
const NON_FIRM_HOSTS = /indeed\.com|glassdoor\.com|ziprecruiter\.com|yelp\.com|bbb\.org|mapquest\.com|yellowpages\.com|crunchbase\.com|zoominfo\.com|manta\.com|google\.com\/maps|goo\.gl/i;

function extractWebsite(description) {
  const urls = description.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (!SOCIAL_HOSTS.test(parsed.hostname) && !NON_FIRM_HOSTS.test(parsed.hostname)) return `${parsed.protocol}//${parsed.hostname}`;
    } catch { /* skip */ }
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

async function crawlSite(site) {
  const result = { email: null, emailSource: null, phone: null, linkedin: null, cityState: null, credentials: new Set() };
  const pages = ['', '/contact', '/contact-us', '/about', '/about-us', '/team'];
  for (const path of pages) {
    const url = site + path;
    const html = await fetchText(url);
    if (!html) continue;
    const text = stripHtml(html);

    if (!result.email) {
      const mailto = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      const candidates = mailto ? [mailto[1]] : (text.match(EMAIL_RE) || []);
      const good = candidates.find((e) => !JUNK_EMAIL.test(e));
      if (good) { result.email = good.toLowerCase(); result.emailSource = url; }
    }
    if (!result.phone) {
      const m = text.match(PHONE_RE);
      if (m) result.phone = m[0].trim();
    }
    if (!result.linkedin) {
      const m = html.match(LINKEDIN_RE);
      if (m) result.linkedin = m[0];
    }
    if (!result.cityState) {
      const m = text.match(CITY_STATE_RE);
      if (m) result.cityState = `${m[1].trim()}, ${m[2]}`;
    }
    for (const c of text.match(CREDENTIAL_RE) || []) result.credentials.add(c);

    // Stop early once we have the core fields
    if (result.email && result.phone && result.cityState) break;
    await sleep(500);
  }
  return result;
}

let n = 0;
for (const ch of channels) {
  if (done.has(ch.channelId)) continue;
  n++;
  // Data scraped from the channel's About page (Apify pre-pass), if any.
  const yt = ytLookup(ch);
  const ytEmail = yt
    ? (yt.business_email || yt.businessEmail
       || (Array.isArray(yt.emails) ? yt.emails[0] : yt.emails) || yt.email || null)
    : null;
  // social_links may be an object ({facebook: url, ...}) or an array.
  const rawSocials = yt ? (yt.social_links || yt.socialLinks || yt.links || []) : [];
  const ytSocials = (Array.isArray(rawSocials) ? rawSocials : Object.values(rawSocials))
    .map((s) => (typeof s === 'string' ? s : s?.url || '')).filter(Boolean);
  const ytSite = ytSocials.find((u) => { try { return !SOCIAL_HOSTS.test(new URL(u).hostname); } catch { return false; } }) || null;

  // Prefer the SEC-registered website for seeded firms; fall back to links in
  // the channel description.
  let seedSite = null;
  if (ch.seedFirm?.website) {
    try {
      // Case-insensitive scheme test: SEC records often store the URL
      // upper-cased (e.g. HTTP://WWW.FIRM.COM). Without the `i` flag the
      // scheme check fails and `https://` gets prepended, yielding
      // `https://HTTP://…` whose hostname parses as bare "http".
      const raw = ch.seedFirm.website.trim();
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      // Skip social profiles and non-firm aggregator/directory pages (a
      // firm's real domain — never indeed.com/glassdoor/yelp, etc.).
      if (!SOCIAL_HOSTS.test(u.hostname) && !NON_FIRM_HOSTS.test(u.hostname)) {
        seedSite = `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}`;
      }
    } catch { /* malformed registered URL */ }
  }
  const website = seedSite || extractWebsite(ch.description) || ytSite;
  let contact = { email: null, emailSource: null, phone: null, linkedin: null, cityState: null, credentials: new Set() };
  if (website) {
    try { contact = await crawlSite(website); } catch { /* keep nulls */ }
  }
  // Fall back to the channel About page (Apify scraper), then the description.
  if (!contact.email && ytEmail && !JUNK_EMAIL.test(ytEmail)) {
    contact.email = ytEmail.toLowerCase();
    contact.emailSource = ch.channelUrl + ' (channel About page via Apify)';
  }
  if (!contact.email) {
    const m = (ch.description.match(EMAIL_RE) || []).find((e) => !JUNK_EMAIL.test(e));
    if (m) { contact.email = m.toLowerCase(); contact.emailSource = ch.channelUrl + ' (channel description)'; }
  }
  // Social links from the About page fill remaining gaps.
  if (!contact.linkedin) {
    const li = ytSocials.find((u) => /linkedin\.com\/(in|company)\//i.test(u));
    if (li) contact.linkedin = li;
  }
  if (!contact.phone && yt) {
    const ph = [].concat(yt.phone_numbers || yt.phoneNumbers || yt.phone || []).find(Boolean);
    if (ph) contact.phone = String(ph);
  }
  const descCreds = ch.description.match(CREDENTIAL_RE) || [];
  const credentials = [...new Set([...contact.credentials, ...descCreds])];

  await appendJsonl('stage2-enriched.jsonl', {
    ...ch,
    firmWebsite: website,
    email: contact.email,
    emailSource: contact.emailSource,
    phone: contact.phone,
    linkedin: contact.linkedin,
    cityState: contact.cityState
      || (ch.seedFirm?.city && ch.seedFirm?.state ? `${ch.seedFirm.city}, ${ch.seedFirm.state}` : null),
    credentials: credentials.join(', ') || null,
  });
  console.log(`[${n}] ${ch.title} — email: ${contact.email || 'none'} site: ${website || 'none'}`);
  await sleep(300);
}
console.log('Stage 2 complete → data/stage2-enriched.jsonl');

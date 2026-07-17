export const config = {
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  maxSearchPagesPerQuery: Number(process.env.MAX_SEARCH_PAGES_PER_QUERY || 3),
  subscriberMin: Number(process.env.SUBSCRIBER_MIN || 1),
  subscriberMax: Number(process.env.SUBSCRIBER_MAX || 25000),
  recencyDays: Number(process.env.RECENCY_DAYS || 60),
  dataDir: new URL('../data/', import.meta.url).pathname,
};

export const SEARCH_QUERIES = [
  'financial advisor',
  'wealth management firm',
  'CFP financial planning',
  'retirement planning CPA',
  'tax planning advisor',
  'RIA registered investment advisor',
  'fee only financial planner',
  'retirement income planning',
  'wealth manager fiduciary',
  'estate planning financial advisor',
  'small business tax advisor CPA',
  '401k rollover advisor',
];

// Signals that a channel is an advisory practice, not a news/influencer channel.
export const PRACTICE_KEYWORDS = /\b(CFP|CPA|CFA|ChFC|CIMA|EA|RIA|fiduciary|wealth management|financial planning|financial advisor|retirement planning|tax planning|advisory|investment adviser|enrolled agent)\b/i;

export const EXCLUDE_KEYWORDS = /\b(crypto signals|day ?trading|forex|meme stocks|get rich|passive income hacks)\b/i;

export const CREDENTIAL_RE = /\b(CFP|CPA|CFA|ChFC|CLU|CIMA|EA|AIF|CDFA|RICP|CRPC|MBA|JD)\b/g;

export const US_STATE_RE = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

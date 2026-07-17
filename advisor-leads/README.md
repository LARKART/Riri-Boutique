# Advisor Leads Pipeline

Builds a verified spreadsheet of US-based financial advisory firms with active
YouTube channels, per the spec in `CLAUDE.md`. **Free-first sequencing**: the
funnel starts from SEC-verified US firms, so legitimacy is front-loaded instead
of verified after the fact.

| Stage | What | Tool | Cost |
|---|---|---|---|
| 0 | Seed list of US-registered advisory firms | **SEC IAPD bulk compilation feed** (adviserinfo.sec.gov) | Free, unlimited |
| 1 | Match firms → YouTube channels + stats/filters | **YouTube Data API v3** | Free, 10k units/day |
| 2 | Email/phone/LinkedIn/city-state from firm sites | Direct crawl of contact/about/team pages | Free |
| 3 | Gap enrichment + finalization | **Apollo.io** free tier → **Hunter.io** free tier (both optional) | Free tiers; budget-gated |
| 4 | Computed fields, dedupe, CSV export | script | — |

Zero npm dependencies — Node ≥ 20.6 stdlib only.

## Setup

1. Free YouTube API key: Google Cloud Console → enable **YouTube Data API v3**.
2. Optional: `APOLLO_API_KEY` (free tier ~10k credits/mo) and `HUNTER_API_KEY`
   (free tier 25–50 searches/mo) for Stage 3 gap enrichment.
3. `cp .env.example .env` and fill in keys.

## Usage

```bash
npm run pipeline    # all stages in order (resumable)
# or stage-by-stage:
npm run seed        # Stage 0: SEC IAPD bulk feed → data/stage0-firms.jsonl
npm run match       # Stage 1: firm → YouTube channel matching (quota-gated, run daily)
npm run enrich      # Stage 2: website contact crawl → stage2-enriched.jsonl
npm run finalize    # Stage 3: Apollo/Hunter gaps + IAPD check + needs_review → stage3-verified.jsonl
npm run export      # Stage 4: computed fields, dedupe → data/advisor-leads.csv

npm run discover    # secondary source: raw YouTube keyword search (finds channels
                    # IAPD matching may miss; these rows get IAPD-verified in Stage 3)
```

All stages checkpoint to JSONL in `data/` and skip already-processed rows —
stop/restart freely.

- Stage 0 auto-probes the last ~14 days of date-stamped feed filenames; you can
  also download the compilation manually from
  https://adviserinfo.sec.gov/compilation and run `node src/stage0-seed.js <file.xml.gz>`.
- Stage 1 matching costs 100 quota units per firm searched (~90 firms/day free);
  it processes the seed list in order and resumes daily via
  `data/stage1-match-progress.jsonl`. A channel is accepted only when ≥70% of
  the firm name's significant tokens appear in the channel title, then it must
  pass all target-profile filters (1–25k subs, upload ≤60 days, US, practice
  keywords).

## Data-quality rules implemented

- Emails only from `mailto:`/page text/channel description (with `emailSource`
  URL) or a Hunter result that itself carries a source page. Never guessed.
- `needs_review: false` only when: SEC-verified (seeded CRD, or IAPD match for
  discovery-mode rows) AND confirmed US city/state AND sourced email.
- Unverifiable fields stay `null`; verification API failures flag the row
  rather than passing it.
- Dedupe on normalized channel URL + firm name; one channel per firm.
- Growth Assessment = least-squares slope of view counts across the 10 most
  recent videos (relative slope > +8% → Growing, < −8% → Declining, else Flat).
  Flat/declining + steady uploads = the client's ideal prospect.
- QA: spot-check a random 5% sample against adviserinfo.sec.gov before delivery.

## Volume reality check

Stages 0–2 are free and unlimited (except the YouTube 10k/day quota — the real
throughput limit: ~90 firm searches/day, so plan multiple weeks of daily `match`
runs, or prioritize the seed list by state/size). Full email coverage across
2,000 rows depends on Stage 3 quotas: free Apollo/Hunter tiers cover a few
hundred gaps/month; the rest ship as `null` + `needs_review` rather than guessed.

## Compliance notes

- Contact data collected is publicly listed business information; outreach must
  comply with CAN-SPAM (identify sender, honor opt-outs).
- YouTube Data API is the ToS-compliant access path; respect the daily quota.
- SEC IAPD compilation data is public domain.

# Project: US Financial Advisor YouTube Lead Database

## Objective
Build a verified spreadsheet of **2,000+ US-based financial advisory firms** with active YouTube channels, for a client running outreach/marketing services targeting advisors who upload consistently but have low subscriber growth.

Accuracy > speed. No fabricated or guessed data. Every row must be traceable to a real source.

---

## Target Profile (qualifying criteria — ALL must be true)

- **Location:** US-based firm (identifiable city + state)
- **Practice type:** Financial advisor, wealth manager, RIA, CFP®, CPA, CFA, retirement planner, tax professional, or financial planning firm
- **YouTube activity:** Uploaded within the last 60 days
- **Subscribers:** Between 1 and 25,000
- **Upload cadence:** Ideally 2+ videos/month average
- **Growth pattern:** Prioritize channels with relatively low subscriber growth despite consistent activity (this is the ideal prospect profile for the client)
- **Content:** Clearly financial advisory / wealth management / tax / retirement planning / accounting — NOT general finance news channels, NOT unlicensed personal-finance influencers, NOT non-US firms

---

## Required Fields (per row)

| # | Field | Notes |
|---|-------|-------|
| 1 | Advisor Name | Full name |
| 2 | Firm Name | |
| 3 | YouTube Channel URL | |
| 4 | Subscriber Count | |
| 5 | Total Videos | |
| 6 | Most Recent Upload Date | YYYY-MM-DD |
| 7 | Avg Views (Last 10 Videos) | Compute from video list |
| 8 | Growth Assessment | Growing / Flat / Declining / Unable to determine |
| 9 | Firm Website | |
| 10 | Primary Contact Email | Must come from official firm domain or channel About page — never guessed via name+domain pattern |
| 11 | Phone Number | US format, only if publicly listed |
| 12 | City & State | US only, e.g. "Austin, TX" |
| 13 | Credentials | CFP, CPA, CFA, ChFC, EA, CIMA, etc. |
| 14 | LinkedIn Profile | If discoverable |
| 15 | needs_review | Boolean flag — set true if US status or any core field is uncertain |

If a field can't be verified, leave it **null**. Do not infer or fabricate.

---

## Pipeline (free-first sequencing — flips funnel to start from verified US firms, not raw YouTube search)

### Stage 0 — Seed List from SEC IAPD (free, unlimited)
**Source:** SEC IAPD bulk data download (adviserinfo.sec.gov)
- Download the public bulk dataset of all SEC/state-registered investment advisers
- Filter to firm size/type matching target profile (RIA, wealth manager, financial planning firm)
- Gives you: firm name, registered address (city/state), often a firm contact — all pre-verified as a legitimate US-registered practice
- This becomes your master candidate list — everything downstream checks *against* this list rather than trying to verify legitimacy after the fact

### Stage 1 — YouTube Match & Channel Stats (free, unlimited)
**Tool:** YouTube Data API v3 (10,000 quota units/day free)
- For each Stage 0 firm, search/match to a YouTube channel (by firm name, advisor name)
- Pull: subscriber count, total videos, last upload date, recent video list w/ view counts
- Filter immediately: subscribers 1–25,000, last upload within 60 days, 2+ uploads/month cadence
- Optional: `apizy/youtube-channel-scraper` (Apify) as a secondary/backup source if API matching misses channels

### Stage 2 — Website Contact Extraction (free, unlimited)
**Method:** Direct script — fetch `/contact`, `/about`, `/team` pages from `firm_website`
- Regex/parse for `mailto:` links and US phone number patterns
- No CAPTCHA exposure — small advisory firm sites rarely have bot protection
- Expect ~40–60% coverage from this step alone at zero cost

### Stage 3 — Enrichment for Remaining Gaps (budget-gated)
**Primary tool:** Apify "Leads Finder" actor ($1.5/1k leads) — replaces Apollo/Hunter
- Use ONLY on leads that passed Stage 0–2 filters and still have null email/phone/LinkedIn
- Accept an email ONLY when its domain matches the firm's own website domain
  (satisfies the "official firm domain" sourcing rule; database leads with
  non-matching domains are rejected, never guessed)
- Track monthly lead usage against APIFY_MONTHLY_LEAD_BUDGET (cost guard)
- Fallbacks (optional, only if keys set): Apollo.io free tier → Hunter.io free tier

### Stage 4 — Computed Fields (script, not a tool)
- **Avg Views (Last 10):** average `viewCount` across the 10 most recent videos from Stage 1's video array
- **Growth Assessment:** derive from upload cadence + view trend (flat/declining views despite steady uploads = ideal target profile for this client)

### Stage 5 — Final Legitimacy Cross-Check
- Since the list originates from SEC IAPD, most legitimacy verification is front-loaded
- Spot-check any leads sourced outside Stage 0 (e.g. added via raw YouTube search) against **FINRA BrokerCheck** or IAPD before marking `needs_review: false`

---

## Volume Reality Check
Free tools alone (Stages 0–2) will get you a large, well-qualified candidate list with partial email coverage quickly and at no cost. Fully **verified** email coverage across all 2,000 rows depends on Stage 3 quota — free tiers alone will likely cover a few hundred; closing the rest of the gap requires either a paid Hunter/Apollo tier or accepting lower email coverage on the final deliverable (with `needs_review`/null clearly marked rather than guessed).

---

## Deduplication & QA
- Dedupe on YouTube Channel URL + Firm Name (normalize URLs, strip tracking params, resolve @handle vs /channel/ID duplicates)
- Spot-check a random 5% sample against SEC IAPD before final delivery
- Final spreadsheet columns must exactly match the 14 required fields above, in order, plus `needs_review`
- Export as clean CSV/XLSX, one row per firm, no partial/duplicate rows

---

## Explicitly Out of Scope
- Non-US firms
- Channels with 0 uploads in last 60 days
- Channels over 25,000 subscribers
- General finance news/media channels with no identifiable licensed advisor or firm
- Guessed emails (pattern-based, e.g. firstname@company.com without confirmation)

---

## Deliverable
Single spreadsheet (CSV or XLSX), 2,000+ verified rows, no duplicates, ready for client CRM import.

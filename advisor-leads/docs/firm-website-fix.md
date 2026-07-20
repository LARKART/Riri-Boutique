# Firm Website column — data bug & fix (2026-07-20)

Reported from a Google Sheet screenshot: several rows showed a wrong/malformed
value in the **Firm Website** column.

## Observed bad values (examples from the screenshot)

| Channel | Firm Website (wrong) | Cause |
|---|---|---|
| @pacificpointwealthmanagement | `https://http` | malformed |
| @capitalstewardshippartners | `https://http` | malformed |
| @withumwealth | `https://http` | malformed |
| @toddhoffmanhpwg | `https://http` | malformed |
| @wynncapital | `https://http` | malformed |
| @edelmanfinancialengines | `https://www.indeed.com` | aggregator page, not the firm |

## Root causes (both in `src/stage2-enrich.js`)

1. **`https://http`** — SEC IAPD records often store the website upper-cased,
   e.g. `HTTP://WWW.WITHUMWEALTH.COM`. The scheme check `/^https?:/` was
   case-sensitive, so it treated the value as scheme-less and prepended
   `https://`, producing `https://HTTP://WWW.WITHUMWEALTH.COM`. `new URL(...)`
   then parses the hostname as the bare word `http` → `https://http`.
   **Fix:** case-insensitive scheme test `/^https?:\/\//i` (+ `.trim()`).

2. **`indeed.com` (and similar)** — a few SEC "website" fields point at job
   boards / directories (`indeed.com/cmp/Edelman-Financial-Engines`) rather than
   the firm's own domain. Stripping the path left `indeed.com`.
   **Fix:** new `NON_FIRM_HOSTS` blocklist (indeed, glassdoor, ziprecruiter,
   yelp, bbb, mapquest, yellowpages, crunchbase, zoominfo, manta, google maps),
   skipped in both the seed-website path and `extractWebsite()`. When the
   registered site is unusable, the firm website falls back to a real link in
   the channel description, or stays `null` (never fabricated).

The 7 affected rows were reset and re-enriched with the fix; the corrected
values were re-exported to `data/advisor-leads.csv` and synced to the Sheet.

# Migration bundle — restore instructions for a new session

This bundle is a complete snapshot of the advisor-leads pipeline as of
2026-07-16, INCLUDING credentials (.env and service-account.json). Treat the
zip itself as a secret.

## Restore steps (for Claude in the new session)

1. Unzip to `~/advisor-leads` (any persistent working dir).
2. Verify secrets restored: `.env` must contain YOUTUBE_API_KEY, APIFY_API_TOKEN,
   APIFY_LEADS_ACTOR_ID, APIFY_YT_EMAIL_ACTOR_ID, GOOGLE_SHEET_ID; and
   `service-account.json` must exist.
3. Run the connectivity check:
   - https://api.adviserinfo.sec.gov (SEC verification)
   - https://api.apify.com (both Apify actors)
   - any firm website (Stage 2 crawling)
   If these are reachable, the environment's network policy is open — proceed
   to step 4. If they 403, the policy is still restricted; the pipeline still
   works in YouTube-only mode.
4. If (and only if) network is open, run the backfill once:
   `rm data/stage2-enriched.jsonl data/stage3-verified.jsonl`
   then `npm run enrich && npm run finalize && npm run export`.
   This gives the existing ~490 rows real emails + SEC verification.
5. Recreate the daily Routine (the old session's trigger has been deleted):
   a persistent trigger, cron `4 9 * * *`, bound to the new session, with the
   prompt stored in `MIGRATION-trigger-prompt.txt`.
6. Confirm the Google Sheet updated (tab "Leads"):
   https://docs.google.com/spreadsheets/d/1WH_7WqgE2UcCeAZ7Bb8i3_RgxzbnjpzLgPq91uJzO3o

## State at snapshot time

- data/stage0-firms.jsonl — 20,085 SEC/state-registered firms, website-first sorted
- data/stage1-channels.jsonl — 492 qualifying channels (477 discovery + matches)
- data/advisor-leads.csv — 490 deduped export rows, all needs_review:true
- data/stage1-match-progress.jsonl — 90 firms already searched (resume point)
- logs/runs.jsonl — full run history (quota accounting reads today's entries)
- Google Sheet sync: WORKING (last sync 490 rows)
- Enrichment/verification: never run with real network (sandbox-blocked)

## Project docs

CLAUDE.md is the spec (field schema, qualifying criteria, dedup rules).
README.md covers commands, quota math, and data-quality rules.

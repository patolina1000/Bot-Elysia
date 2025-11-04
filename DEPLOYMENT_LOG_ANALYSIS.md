# Deployment Log Analysis - Telegram Contacts Backfill Failure

## Summary of Findings
- The deployment fails while executing the migration `20251017_b_backfill_telegram_contacts.sql` because it references the column `occurred_at` in the `funnel_events` table.
- In the target database the column `occurred_at` is missing, so PostgreSQL raises `ERROR: column fe.occurred_at does not exist` and the migration runner aborts.
- Multiple earlier migrations show checksum mismatches. Render deploys continue because the environment variable `MIGRATIONS_FORCE` is set, which forces execution even when the migration files diverge from the checksums that were recorded when they originally ran. This indicates that the migration scripts in the repository were edited after being applied in production, which can hide incompatibilities between the code base and the live schema.

## Root Cause
1. The backfill migration `20251017_b_backfill_telegram_contacts.sql` expects `funnel_events` to expose `occurred_at`.
2. The repository introduces `occurred_at` only in later migrations (e.g. `20251103_align_funnel_events_occurred_at.sql` and `20251018_quick_checks_v2.sql`), but these come after the failing backfill in chronological order and therefore have not run yet when the failure occurs.
3. Because the production database still reflects the older schema (without `occurred_at`), the backfill references a non-existent column and fails.

## Additional Problems Observed
- Every migration up to `20251016_add_extra_plans_to_bot_downsells.sql` reports checksum mismatches against the applied records. With `MIGRATIONS_FORCE` enabled the deploy ignores the guard, but this leaves the database at risk because the scripted changes may no longer match what is already applied.
- Three migrations (`20251016_downsells_metrics.sql`, `20251017_a_create_telegram_contacts.sql`, `20251017_add_error_to_shots_sent.sql`) now appear as `DIVERGED` after the failed run, meaning they were recorded with the old checksum in the database but their on-disk contents differ. Re-running them without reconciliation can cause repeated warnings or inconsistent schema states.

## Remediation Implemented
1. Added `20251017_a_guard_funnel_events_occurred_at.sql`, a new migration that guarantees the `funnel_events.occurred_at` column exists, backfills missing data from `created_at`, and sets a default before the Telegram contacts backfill runs.
2. Hardened `runMigrations.ts` so that production deployments abort when `MIGRATIONS_FORCE` is set without an explicit `MIGRATIONS_FORCE_ACK=1`, forcing teams to reconcile divergences instead of silently skipping checksum mismatches.

## Additional Recommended Steps
1. Run `npm run sanity:migrations:reconcile -- --accept` (or set `MIGRATIONS_ACCEPT=1` during deploy) to align historical checksums with the versions currently in production and eliminate the reported divergences.
2. Unset `MIGRATIONS_FORCE` in the Render service configuration once the reconciliation is complete. The new safeguard will block accidental usage in production, but removing the variable avoids needless deploy failures.

-- Establishes the core tables for shots and shot plans while remaining idempotent.
BEGIN;

-- Ensure the shots table exists with the desired schema for campaign metadata.
CREATE TABLE IF NOT EXISTS shots (
    id BIGSERIAL PRIMARY KEY,
    bot_slug TEXT NOT NULL,
    title TEXT NULL,
    copy TEXT NULL,
    media_url TEXT NULL,
    media_type TEXT NULL,
    target TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Align the shots table columns and constraints in case the table already existed.
ALTER TABLE shots ADD COLUMN IF NOT EXISTS bot_slug TEXT;
ALTER TABLE shots ALTER COLUMN bot_slug SET NOT NULL;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS copy TEXT;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS target TEXT;

-- Backfill existing rows that might have null targets from previous schemas.
UPDATE shots
SET target = 'all_started'
WHERE target IS NULL;

ALTER TABLE shots ALTER COLUMN target SET NOT NULL;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE shots ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE shots ALTER COLUMN created_at SET DEFAULT now();

-- Enforce the allowed media types without introducing enum types.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'shots_media_type_check'
          AND conrelid = 'shots'::regclass
    ) THEN
        ALTER TABLE shots
            ADD CONSTRAINT shots_media_type_check
            CHECK (media_type IS NULL OR media_type IN ('photo', 'video', 'audio', 'document', 'none'));
    END IF;
END
$$;

-- Restrict shot targeting modes to the approved set.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'shots_target_check'
          AND conrelid = 'shots'::regclass
    ) THEN
        ALTER TABLE shots
            ADD CONSTRAINT shots_target_check
            CHECK (target IN ('all_started', 'pix_generated'));
    END IF;
END
$$;

-- Provide fast lookups by bot slug.
CREATE INDEX IF NOT EXISTS shots_bot_slug_idx ON shots (bot_slug);
-- Support scheduling queries for upcoming shots.
CREATE INDEX IF NOT EXISTS shots_scheduled_at_idx ON shots (scheduled_at);

-- Ensure the shot_plans table exists to store plan-specific pricing for shots.
CREATE TABLE IF NOT EXISTS shot_plans (
    id BIGSERIAL PRIMARY KEY,
    shot_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    price_cents INT NOT NULL DEFAULT 0,
    description TEXT NULL,
    sort_order INT NOT NULL DEFAULT 0
);

-- Align the shot_plans table columns in case the table already existed.
ALTER TABLE shot_plans ADD COLUMN IF NOT EXISTS shot_id BIGINT;
ALTER TABLE shot_plans ALTER COLUMN shot_id SET NOT NULL;
ALTER TABLE shot_plans ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE shot_plans ALTER COLUMN name SET NOT NULL;
ALTER TABLE shot_plans ADD COLUMN IF NOT EXISTS price_cents INT;
ALTER TABLE shot_plans ALTER COLUMN price_cents SET NOT NULL;
ALTER TABLE shot_plans ALTER COLUMN price_cents SET DEFAULT 0;
ALTER TABLE shot_plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE shot_plans ADD COLUMN IF NOT EXISTS sort_order INT;
ALTER TABLE shot_plans ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE shot_plans ALTER COLUMN sort_order SET DEFAULT 0;

-- Maintain the cascade relationship to shots.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'shot_plans_shot_id_fkey'
          AND conrelid = 'shot_plans'::regclass
    ) THEN
        ALTER TABLE shot_plans
            ADD CONSTRAINT shot_plans_shot_id_fkey
            FOREIGN KEY (shot_id)
            REFERENCES shots (id)
            ON DELETE CASCADE;
    END IF;
END
$$;

-- Provide a stable ordering by plan priority per shot.
CREATE INDEX IF NOT EXISTS shot_plans_shot_id_sort_idx ON shot_plans (shot_id, sort_order);

-- Emit an informational log for the migration runner.
DO $$
BEGIN
    RAISE NOTICE '[MIG][SHOTS_CORE] shots_core migration applied successfully.';
END
$$;

COMMIT;

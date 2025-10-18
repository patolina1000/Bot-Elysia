-- ============================================================================
-- Shots schema alignment migration
-- Aligns shots, shot_plans and shots_queue tables with the new standard
-- Ensures idempotent structure, constraints, indexes and data hygiene
-- ============================================================================

-- --------------------------------------------------------------------------
-- Lock relevant tables to reduce race conditions during deploy
-- --------------------------------------------------------------------------
LOCK TABLE IF EXISTS public.shots IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE IF EXISTS public.shot_plans IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE IF EXISTS public.shots_queue IN SHARE ROW EXCLUSIVE MODE;

-- --------------------------------------------------------------------------
-- Ensure shots table exists with required columns and constraints
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shots (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  title TEXT,
  copy TEXT,
  media_url TEXT,
  media_type TEXT,
  target TEXT,
  scheduled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guarantee optional columns exist (idempotent checks)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shots' AND column_name = 'title'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN title TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shots' AND column_name = 'copy'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN copy TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shots' AND column_name = 'media_url'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN media_url TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shots' AND column_name = 'media_type'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN media_type TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shots' AND column_name = 'target'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN target TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shots' AND column_name = 'scheduled_at'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN scheduled_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shots' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE public.shots ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END;
$$;

-- Enforce NOT NULL and defaults
ALTER TABLE public.shots
  ALTER COLUMN bot_slug SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now();

-- Media type constraint (photo, video, audio, document, none)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shots_media_type_check'
      AND conrelid = 'public.shots'::regclass
  ) THEN
    -- No-op if constraint already exists
    NULL;
  ELSE
    ALTER TABLE public.shots
      ADD CONSTRAINT shots_media_type_check
      CHECK (media_type IS NULL OR media_type IN ('photo', 'video', 'audio', 'document', 'none'));
  END IF;
END;
$$;

-- Target constraint (all_started, pix_generated)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shots_target_check'
      AND conrelid = 'public.shots'::regclass
  ) THEN
    NULL;
  ELSE
    ALTER TABLE public.shots
      ADD CONSTRAINT shots_target_check
      CHECK (target IS NULL OR target IN ('all_started', 'pix_generated'));
  END IF;
END;
$$;

-- Normalize legacy values to the supported enums
UPDATE public.shots
SET media_type = CASE
  WHEN media_type IS NULL THEN NULL
  WHEN media_type IN ('photo', 'video', 'audio', 'document', 'none') THEN media_type
  ELSE 'none'
END
WHERE media_type IS NOT NULL
  AND media_type NOT IN ('photo', 'video', 'audio', 'document', 'none');

UPDATE public.shots
SET target = CASE
  WHEN target IN ('all_started', 'started') THEN 'all_started'
  WHEN target IN ('pix_generated', 'pix_created') THEN 'pix_generated'
  ELSE NULL
END
WHERE target IS NOT NULL
  AND target NOT IN ('all_started', 'pix_generated');

-- Helpful indexes
CREATE INDEX IF NOT EXISTS shots_bot_slug_idx ON public.shots (bot_slug);
CREATE INDEX IF NOT EXISTS shots_scheduled_at_idx ON public.shots (scheduled_at);

-- --------------------------------------------------------------------------
-- Ensure shot_plans table exists with proper structure
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shot_plans (
  id BIGSERIAL PRIMARY KEY,
  shot_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  price_cents INT NOT NULL DEFAULT 0,
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0
);

-- Columns & defaults
ALTER TABLE public.shot_plans
  ALTER COLUMN price_cents SET DEFAULT 0,
  ALTER COLUMN price_cents SET NOT NULL,
  ALTER COLUMN sort_order SET DEFAULT 0,
  ALTER COLUMN sort_order SET NOT NULL,
  ALTER COLUMN shot_id SET NOT NULL,
  ALTER COLUMN name SET NOT NULL;

-- Foreign key to shots (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shot_plans_shot_id_fkey'
      AND conrelid = 'public.shot_plans'::regclass
  ) THEN
    ALTER TABLE public.shot_plans
      ADD CONSTRAINT shot_plans_shot_id_fkey
      FOREIGN KEY (shot_id)
      REFERENCES public.shots(id)
      ON DELETE CASCADE;
  END IF;
END;
$$;

-- Index for ordering inside a shot
CREATE INDEX IF NOT EXISTS shot_plans_shot_id_sort_order_idx
  ON public.shot_plans (shot_id, sort_order);

-- --------------------------------------------------------------------------
-- Shots queue structure adjustments
-- --------------------------------------------------------------------------
-- Ensure key columns exist
ALTER TABLE IF EXISTS public.shots_queue
  ADD COLUMN IF NOT EXISTS shot_id BIGINT,
  ADD COLUMN IF NOT EXISTS telegram_id BIGINT,
  ADD COLUMN IF NOT EXISTS attempts INT,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Normalize types from legacy enums to TEXT
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'status'
      AND data_type = 'USER-DEFINED'
  ) THEN
    ALTER TABLE public.shots_queue
      ALTER COLUMN status TYPE TEXT USING status::TEXT;
  END IF;
END;
$$;

-- Attempts defaults and NOT NULL
ALTER TABLE IF EXISTS public.shots_queue
  ALTER COLUMN attempts SET DEFAULT 0,
  ALTER COLUMN attempts SET NOT NULL;

-- Keep legacy attempt_count column aligned when present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'attempt_count'
  ) THEN
    ALTER TABLE public.shots_queue
      ALTER COLUMN attempt_count SET DEFAULT 0;

    UPDATE public.shots_queue
    SET attempt_count = COALESCE(attempt_count, 0)
    WHERE attempt_count IS NULL;

    ALTER TABLE public.shots_queue
      ALTER COLUMN attempt_count SET NOT NULL;
  END IF;
END;
$$;

-- Legacy attempt_count alignment (keep old column if present)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'attempt_count'
  ) THEN
    UPDATE public.shots_queue
    SET attempts = COALESCE(attempts, attempt_count, 0)
    WHERE attempts IS NULL
       OR attempts <> COALESCE(attempt_count, 0);

    UPDATE public.shots_queue
    SET attempt_count = COALESCE(attempts, attempt_count, 0)
    WHERE attempt_count IS NULL
       OR attempt_count <> COALESCE(attempts, 0);
  ELSE
    UPDATE public.shots_queue
    SET attempts = COALESCE(attempts, 0)
    WHERE attempts IS NULL;
  END IF;
END;
$$;

-- Guarantee defaults/not nulls for timing columns
ALTER TABLE IF EXISTS public.shots_queue
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

-- Allow scheduled_at to be nullable while preserving data
ALTER TABLE IF EXISTS public.shots_queue
  ALTER COLUMN scheduled_at DROP NOT NULL;

-- Status defaults
ALTER TABLE IF EXISTS public.shots_queue
  ALTER COLUMN status SET DEFAULT 'pending';

-- Normalize status values and cap to the new domain
UPDATE public.shots_queue
SET status = CASE
  WHEN status IN ('pending', 'processing', 'success', 'error') THEN status
  WHEN status = 'running' THEN 'processing'
  WHEN status = 'sent' THEN 'success'
  WHEN status = 'skipped' THEN 'error'
  ELSE 'pending'
END;

-- Clean up attempts nulls post-sync
UPDATE public.shots_queue
SET attempts = 0
WHERE attempts IS NULL;

-- Ensure timestamp columns are populated before NOT NULL enforcement
UPDATE public.shots_queue
SET created_at = COALESCE(created_at, now())
WHERE created_at IS NULL;

UPDATE public.shots_queue
SET updated_at = COALESCE(updated_at, now())
WHERE updated_at IS NULL;

-- Backfill shot records and relationships
DO $$
DECLARE
  rec RECORD;
  new_shot_id BIGINT;
  media_value TEXT;
  target_value TEXT;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
  ) THEN
    FOR rec IN
      SELECT q.id,
             q.bot_slug,
             q.copy,
             q.media_url,
             q.media_type,
             q.target,
             q.scheduled_at
      FROM public.shots_queue q
      WHERE q.shot_id IS NULL
    LOOP
      media_value := CASE
        WHEN rec.media_type IN ('photo', 'video', 'audio', 'document', 'none') THEN rec.media_type
        ELSE 'none'
      END;

      target_value := CASE
        WHEN rec.target IN ('all_started', 'started') THEN 'all_started'
        WHEN rec.target IN ('pix_generated', 'pix_created') THEN 'pix_generated'
        ELSE NULL
      END;

      INSERT INTO public.shots (
        bot_slug,
        title,
        copy,
        media_url,
        media_type,
        target,
        scheduled_at
      )
      VALUES (
        COALESCE(NULLIF(rec.bot_slug, ''), 'unknown_bot'),
        CONCAT('Shot ', rec.id),
        rec.copy,
        rec.media_url,
        media_value,
        target_value,
        rec.scheduled_at
      )
      RETURNING id INTO new_shot_id;

      UPDATE public.shots_queue
      SET shot_id = new_shot_id
      WHERE id = rec.id;
    END LOOP;
  END IF;
END;
$$;

-- Backfill bot_slug using shots reference when null
UPDATE public.shots_queue q
SET bot_slug = s.bot_slug
FROM public.shots s
WHERE q.shot_id = s.id
  AND (q.bot_slug IS NULL OR q.bot_slug = '');

UPDATE public.shots_queue
SET bot_slug = 'unknown_bot'
WHERE bot_slug IS NULL OR bot_slug = '';

-- Ensure telegram_id present (fallback to 0 when missing)
UPDATE public.shots_queue
SET telegram_id = 0
WHERE telegram_id IS NULL;

-- Ensure attempts mirror legacy column if present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'attempt_count'
  ) THEN
    UPDATE public.shots_queue
    SET attempt_count = attempts
    WHERE attempt_count IS DISTINCT FROM attempts;
  END IF;
END;
$$;

-- Remove orphan queue rows (shot_id without parent)
DELETE FROM public.shots_queue q
WHERE q.shot_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.shots s WHERE s.id = q.shot_id
  );

-- Final NOT NULL enforcement after backfills
ALTER TABLE IF EXISTS public.shots_queue
  ALTER COLUMN bot_slug SET NOT NULL,
  ALTER COLUMN telegram_id SET NOT NULL,
  ALTER COLUMN shot_id SET NOT NULL,
  ALTER COLUMN attempts SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

-- Status constraint (pending|processing|success|error)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shots_queue_status_check'
      AND conrelid = 'public.shots_queue'::regclass
  ) THEN
    ALTER TABLE public.shots_queue
      DROP CONSTRAINT shots_queue_status_check;
  END IF;

  ALTER TABLE public.shots_queue
    ADD CONSTRAINT shots_queue_status_check
    CHECK (status IN ('pending', 'processing', 'success', 'error'));
END;
$$;

-- Attempts constraint sync trigger to keep attempt_count compatible
CREATE OR REPLACE FUNCTION public.shots_queue_sync_attempts()
RETURNS TRIGGER AS $$
BEGIN
  NEW.attempts := COALESCE(NEW.attempts, NEW.attempt_count, 0);
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'attempt_count'
  ) THEN
    NEW.attempt_count := COALESCE(NEW.attempt_count, NEW.attempts, 0);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shots_queue_sync_attempts_trigger ON public.shots_queue;
CREATE TRIGGER shots_queue_sync_attempts_trigger
  BEFORE INSERT OR UPDATE ON public.shots_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.shots_queue_sync_attempts();

-- Status normalization trigger to keep legacy writers compatible
CREATE OR REPLACE FUNCTION public.shots_queue_normalize_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'running' THEN
    NEW.status := 'processing';
  ELSIF NEW.status = 'sent' THEN
    NEW.status := 'success';
  ELSIF NEW.status = 'skipped' THEN
    NEW.status := 'error';
  ELSIF NEW.status NOT IN ('pending', 'processing', 'success', 'error') THEN
    NEW.status := 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shots_queue_normalize_status_trigger ON public.shots_queue;
CREATE TRIGGER shots_queue_normalize_status_trigger
  BEFORE INSERT OR UPDATE ON public.shots_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.shots_queue_normalize_status();

-- Foreign key linking queue to shots
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shots_queue_shot_id_fkey'
      AND conrelid = 'public.shots_queue'::regclass
  ) THEN
    ALTER TABLE public.shots_queue
      ADD CONSTRAINT shots_queue_shot_id_fkey
      FOREIGN KEY (shot_id)
      REFERENCES public.shots(id)
      ON DELETE CASCADE;
  END IF;
END;
$$;

-- Essential indexes
CREATE INDEX IF NOT EXISTS shots_queue_status_due_idx
  ON public.shots_queue (status, next_retry_at);

CREATE INDEX IF NOT EXISTS shots_queue_sched_idx
  ON public.shots_queue (scheduled_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_shots_queue_unique
  ON public.shots_queue (shot_id, telegram_id);

CREATE INDEX IF NOT EXISTS shots_queue_bot_slug_idx
  ON public.shots_queue (bot_slug);

-- Final migration log summary
DO $$
DECLARE
  pending_nulls INT;
BEGIN
  SELECT COUNT(*)
  INTO pending_nulls
  FROM public.shots_queue
  WHERE bot_slug IS NULL;

  RAISE NOTICE '===============================================================';
  RAISE NOTICE '✅ Shots schema migration executed.';
  RAISE NOTICE '✅ Remaining shots_queue.bot_slug NULL count: %', pending_nulls;
  RAISE NOTICE '===============================================================';
END;
$$;

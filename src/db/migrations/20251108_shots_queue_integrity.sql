-- ============================================================================
-- shots_queue integrity hardening
-- - enforce automatic updated_at updates via trigger
-- - clean legacy nulls and enforce NOT NULL constraints
-- - align indexes with worker expectations
-- ============================================================================

LOCK TABLE IF EXISTS public.shots_queue IN SHARE ROW EXCLUSIVE MODE;

-- Ensure the generic touch_updated_at helper exists.
CREATE OR REPLACE FUNCTION public.shots_queue_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach the trigger (drop legacy ones to avoid duplicates).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_shots_queue_touch'
      AND tgrelid = 'public.shots_queue'::regclass
  ) THEN
    EXECUTE 'DROP TRIGGER trg_shots_queue_touch ON public.shots_queue';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'shots_queue_set_updated_at'
      AND tgrelid = 'public.shots_queue'::regclass
  ) THEN
    EXECUTE 'DROP TRIGGER shots_queue_set_updated_at ON public.shots_queue';
  END IF;
END; $$;

CREATE TRIGGER shots_queue_set_updated_at
  BEFORE UPDATE ON public.shots_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.shots_queue_touch_updated_at();

-- Normalize data so NOT NULL constraints succeed.
DO $$
DECLARE
  backfilled_count BIGINT := 0;
  deleted_missing_refs BIGINT := 0;
  deleted_missing_bot BIGINT := 0;
BEGIN
  UPDATE public.shots_queue sq
  SET bot_slug = s.bot_slug
  FROM public.shots s
  WHERE sq.bot_slug IS NULL
    AND sq.shot_id IS NOT NULL
    AND s.id = sq.shot_id
    AND s.bot_slug IS NOT NULL;
  GET DIAGNOSTICS backfilled_count = ROW_COUNT;

  DELETE FROM public.shots_queue
  WHERE shot_id IS NULL
     OR telegram_id IS NULL;
  GET DIAGNOSTICS deleted_missing_refs = ROW_COUNT;

  DELETE FROM public.shots_queue
  WHERE bot_slug IS NULL;
  GET DIAGNOSTICS deleted_missing_bot = ROW_COUNT;

  RAISE NOTICE '[MIG][SHOTS_QUEUE] Backfilled bot_slug from shots: %', backfilled_count;
  RAISE NOTICE '[MIG][SHOTS_QUEUE] Deleted rows missing shot_id/telegram_id: %', deleted_missing_refs;
  RAISE NOTICE '[MIG][SHOTS_QUEUE] Deleted rows still missing bot_slug: %', deleted_missing_bot;
END; $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'shot_id'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.shots_queue ALTER COLUMN shot_id SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'bot_slug'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.shots_queue ALTER COLUMN bot_slug SET NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'telegram_id'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.shots_queue ALTER COLUMN telegram_id SET NOT NULL';
  END IF;
END; $$;

-- Remove legacy indexes that conflict with the target naming.
DO $$
DECLARE
  idx RECORD;
BEGIN
  FOR idx IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shots_queue'
      AND indexname <> 'ux_shots_queue_shot_id_telegram_id'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%ON public.shots_queue% (shot_id, telegram_id%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', idx.indexname);
  END LOOP;

  FOR idx IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shots_queue'
      AND indexname <> 'shots_queue_bot_idx'
      AND indexdef ILIKE 'CREATE INDEX%ON public.shots_queue% (bot_slug%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', idx.indexname);
  END LOOP;

  FOR idx IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shots_queue'
      AND indexname <> 'shots_queue_sched_idx'
      AND indexdef ILIKE 'CREATE INDEX%ON public.shots_queue% (scheduled_at%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', idx.indexname);
  END LOOP;
END; $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_shots_queue_shot_id_telegram_id
  ON public.shots_queue (shot_id, telegram_id);

CREATE INDEX IF NOT EXISTS shots_queue_status_due_idx
  ON public.shots_queue (status, next_retry_at);

CREATE INDEX IF NOT EXISTS shots_queue_sched_idx
  ON public.shots_queue (scheduled_at);

CREATE INDEX IF NOT EXISTS shots_queue_bot_idx
  ON public.shots_queue (bot_slug);

DO $$
BEGIN
  RAISE NOTICE '[MIG][SHOTS_QUEUE] Integrity hardening completed.';
END; $$;

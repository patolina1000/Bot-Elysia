-- [MIG][SHOTS_QUEUE] Detect existing shots_queue schema and archive incompatible layouts.
DO $$
DECLARE
  table_exists BOOLEAN;
  has_shot_id BOOLEAN;
  has_telegram_id BOOLEAN;
  legacy_name TEXT := '';
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
  ) INTO table_exists;

  IF table_exists THEN
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'shots_queue'
        AND column_name = 'shot_id'
    ) INTO has_shot_id;

    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'shots_queue'
        AND column_name = 'telegram_id'
    ) INTO has_telegram_id;

    IF NOT (has_shot_id AND has_telegram_id) THEN
      legacy_name := 'shots_queue_legacy_' || to_char(now(), 'YYYYMMDDHH24MI');
      EXECUTE format('ALTER TABLE public.shots_queue RENAME TO %I', legacy_name);
      PERFORM set_config('shots_queue.legacy_table', legacy_name, true);
      RAISE NOTICE '[MIG][SHOTS_QUEUE] Renamed incompatible shots_queue table to %', legacy_name;
    ELSE
      PERFORM set_config('shots_queue.legacy_table', '', true);
      RAISE NOTICE '[MIG][SHOTS_QUEUE] Existing shots_queue already contains essential columns.';
    END IF;
  ELSE
    PERFORM set_config('shots_queue.legacy_table', '', true);
    RAISE NOTICE '[MIG][SHOTS_QUEUE] shots_queue table not found. A fresh table will be created.';
  END IF;
END;
$$;

-- [MIG][SHOTS_QUEUE] Ensure shots_queue table exists with the target per-recipient schema.
CREATE TABLE IF NOT EXISTS public.shots_queue (
  id            BIGSERIAL PRIMARY KEY,
  shot_id       BIGINT  NOT NULL,
  bot_slug      TEXT    NOT NULL,
  telegram_id   BIGINT  NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','success','error')),
  attempts      INT     NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NULL,
  scheduled_at  TIMESTAMPTZ NULL,
  last_error    TEXT    NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- [MIG][SHOTS_QUEUE] Align mandatory columns, defaults and data types.
ALTER TABLE public.shots_queue
  ADD COLUMN IF NOT EXISTS id BIGINT,
  ADD COLUMN IF NOT EXISTS shot_id BIGINT,
  ADD COLUMN IF NOT EXISTS bot_slug TEXT,
  ADD COLUMN IF NOT EXISTS telegram_id BIGINT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS attempts INT,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE public.shots_queue
  ALTER COLUMN status TYPE TEXT USING status::TEXT;

ALTER TABLE public.shots_queue
  ALTER COLUMN attempts TYPE INT USING attempts::INT;

ALTER TABLE public.shots_queue
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN attempts SET DEFAULT 0;

-- [MIG][SHOTS_QUEUE] Guarantee id column behaves as BIGSERIAL primary key.
DO $$
DECLARE
  seq_name TEXT;
BEGIN
  seq_name := pg_get_serial_sequence('public.shots_queue', 'id');
  IF seq_name IS NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.sequences
      WHERE sequence_schema = 'public'
        AND sequence_name = 'shots_queue_id_seq'
    ) THEN
      EXECUTE 'CREATE SEQUENCE public.shots_queue_id_seq';
    END IF;
    EXECUTE 'SELECT setval(''public.shots_queue_id_seq'', COALESCE((SELECT max(id) FROM public.shots_queue),0))';
    ALTER TABLE public.shots_queue
      ALTER COLUMN id SET DEFAULT nextval('public.shots_queue_id_seq');
    ALTER SEQUENCE public.shots_queue_id_seq OWNED BY public.shots_queue.id;
  ELSE
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT max(id) FROM public.shots_queue),0))', seq_name);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE public.shots_queue
      ADD PRIMARY KEY (id);
    RAISE NOTICE '[MIG][SHOTS_QUEUE] Added primary key on id.';
  END IF;
END;
$$;

-- [MIG][SHOTS_QUEUE] Drop legacy columns that are incompatible with the per-recipient schema.
DO $$
DECLARE
  col RECORD;
BEGIN
  FOR col IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name NOT IN (
        'id','shot_id','bot_slug','telegram_id','status','attempts','next_retry_at','scheduled_at','last_error','created_at','updated_at'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.shots_queue DROP COLUMN %I CASCADE', col.column_name);
    RAISE NOTICE '[MIG][SHOTS_QUEUE] Dropped legacy column %', col.column_name;
  END LOOP;
END;
$$;

-- [MIG][SHOTS_QUEUE] Copy data from legacy table when it contains compatible columns.
DO $$
DECLARE
  legacy_name TEXT := '';
  has_shot_id BOOLEAN := FALSE;
  has_telegram_id BOOLEAN := FALSE;
  has_bot_slug BOOLEAN := FALSE;
  has_status BOOLEAN := FALSE;
  has_attempts BOOLEAN := FALSE;
  has_attempt_count BOOLEAN := FALSE;
  has_next_retry_at BOOLEAN := FALSE;
  has_scheduled_at BOOLEAN := FALSE;
  has_last_error BOOLEAN := FALSE;
  has_created_at BOOLEAN := FALSE;
  has_updated_at BOOLEAN := FALSE;
  insert_sql TEXT;
BEGIN
  BEGIN
    legacy_name := current_setting('shots_queue.legacy_table', true);
  EXCEPTION
    WHEN others THEN
      legacy_name := '';
  END;

  IF legacy_name IS NULL OR legacy_name = '' THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = legacy_name
      AND column_name = 'shot_id'
  ) INTO has_shot_id;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = legacy_name
      AND column_name = 'telegram_id'
  ) INTO has_telegram_id;

  IF NOT (has_shot_id AND has_telegram_id) THEN
    RAISE NOTICE '[MIG][SHOTS_QUEUE] Legacy table % lacks required columns; skipping copy.', legacy_name;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = legacy_name AND column_name = 'bot_slug'
  ) INTO has_bot_slug;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = legacy_name AND column_name = 'status'
  ) INTO has_status;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = legacy_name AND column_name = 'attempts'
  ) INTO has_attempts;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = legacy_name AND column_name = 'attempt_count'
  ) INTO has_attempt_count;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = legacy_name AND column_name = 'next_retry_at'
  ) INTO has_next_retry_at;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = legacy_name AND column_name = 'scheduled_at'
  ) INTO has_scheduled_at;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = legacy_name AND column_name = 'last_error'
  ) INTO has_last_error;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = legacy_name AND column_name = 'created_at'
  ) INTO has_created_at;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = legacy_name AND column_name = 'updated_at'
  ) INTO has_updated_at;

  insert_sql := format(
    'INSERT INTO public.shots_queue (
       shot_id, bot_slug, telegram_id, status, attempts, next_retry_at, scheduled_at, last_error, created_at, updated_at
     )
     SELECT
       shot_id,
       %s,
       telegram_id,
       %s,
       %s,
       %s,
       %s,
       %s,
       %s,
       %s
     FROM public.%I
     WHERE shot_id IS NOT NULL
       AND telegram_id IS NOT NULL
     ON CONFLICT (shot_id, telegram_id) DO NOTHING',
    CASE WHEN has_bot_slug THEN 'NULLIF(bot_slug, '''')' ELSE '''''' END,
    CASE WHEN has_status THEN 'NULLIF(status::text, '''')' ELSE '''pending''' END,
    CASE
      WHEN has_attempts THEN 'COALESCE(attempts, 0)'
      WHEN has_attempt_count THEN 'COALESCE(attempt_count, 0)'
      ELSE '0'
    END,
    CASE WHEN has_next_retry_at THEN 'next_retry_at' ELSE 'NULL' END,
    CASE WHEN has_scheduled_at THEN 'scheduled_at' ELSE 'NULL' END,
    CASE WHEN has_last_error THEN 'last_error' ELSE 'NULL' END,
    CASE WHEN has_created_at THEN 'COALESCE(created_at, now())' ELSE 'now()' END,
    CASE WHEN has_updated_at THEN 'COALESCE(updated_at, now())' ELSE 'now()' END,
    legacy_name
  );

  EXECUTE insert_sql;
  RAISE NOTICE '[MIG][SHOTS_QUEUE] Copied legacy rows from %.', legacy_name;
END;
$$;

-- [MIG][SHOTS_QUEUE] Normalize and backfill required values.
UPDATE public.shots_queue q
SET bot_slug = s.bot_slug
FROM public.shots s
WHERE q.shot_id = s.id
  AND (q.bot_slug IS NULL OR q.bot_slug = '');

UPDATE public.shots_queue
SET status = 'pending'
WHERE status IS NULL
   OR status NOT IN ('pending','processing','success','error');

UPDATE public.shots_queue
SET attempts = 0
WHERE attempts IS NULL;

UPDATE public.shots_queue
SET created_at = now()
WHERE created_at IS NULL;

UPDATE public.shots_queue
SET updated_at = now()
WHERE updated_at IS NULL;

-- [MIG][SHOTS_QUEUE] Enforce NOT NULL constraints after backfill.
ALTER TABLE public.shots_queue
  ALTER COLUMN shot_id SET NOT NULL,
  ALTER COLUMN bot_slug SET NOT NULL,
  ALTER COLUMN telegram_id SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN attempts SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

-- [MIG][SHOTS_QUEUE] Ensure the status check constraint matches the allowed values.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'shots_queue_status_check'
      AND conrelid = 'public.shots_queue'::regclass
  ) THEN
    ALTER TABLE public.shots_queue
      DROP CONSTRAINT shots_queue_status_check;
  END IF;

  ALTER TABLE public.shots_queue
    ADD CONSTRAINT shots_queue_status_check
    CHECK (status IN ('pending','processing','success','error'));
END;
$$;

-- [MIG][SHOTS_QUEUE] Create or update the touch trigger function.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'fn_touch_updated_at'
      AND pg_function_is_visible(oid)
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.fn_touch_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    $fn$;
  END IF;
  END;
  $$;

-- [MIG][SHOTS_QUEUE] Attach the updated_at trigger in an idempotent way.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_shots_queue_touch'
      AND tgrelid = 'public.shots_queue'::regclass
  ) THEN
    EXECUTE 'DROP TRIGGER trg_shots_queue_touch ON public.shots_queue';
  END IF;

  EXECUTE 'CREATE TRIGGER trg_shots_queue_touch BEFORE UPDATE ON public.shots_queue FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at()';
  END;
  $$;

-- [MIG][SHOTS_QUEUE] Ensure required indexes exist for worker efficiency.
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
  RAISE NOTICE '[MIG][SHOTS_QUEUE] Per-recipient queue schema ensured.';
END;
$$;


DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'downsells_queue'
      AND column_name = 'attempt_count'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue ADD COLUMN attempt_count INT';
    EXECUTE 'UPDATE public.downsells_queue SET attempt_count = 0 WHERE attempt_count IS NULL';
    EXECUTE 'ALTER TABLE public.downsells_queue ALTER COLUMN attempt_count SET DEFAULT 0';
    EXECUTE 'ALTER TABLE public.downsells_queue ALTER COLUMN attempt_count SET NOT NULL';
  ELSE
    EXECUTE 'UPDATE public.downsells_queue SET attempt_count = 0 WHERE attempt_count IS NULL';
    EXECUTE 'ALTER TABLE public.downsells_queue ALTER COLUMN attempt_count SET DEFAULT 0';
    EXECUTE 'ALTER TABLE public.downsells_queue ALTER COLUMN attempt_count SET NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'downsells_queue'
      AND column_name = 'last_error'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue ADD COLUMN last_error TEXT';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'downsells_queue'
      AND column_name = 'updated_at'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now()';
  ELSE
    EXECUTE 'ALTER TABLE public.downsells_queue ALTER COLUMN updated_at SET DEFAULT now()';
    EXECUTE 'UPDATE public.downsells_queue SET updated_at = now() WHERE updated_at IS NULL';
    EXECUTE 'ALTER TABLE public.downsells_queue ALTER COLUMN updated_at SET NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'downsells_queue'
      AND column_name = 'transaction_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue ADD COLUMN transaction_id TEXT';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'downsells_queue'
      AND column_name = 'external_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue ADD COLUMN external_id TEXT';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'downsells_queue'
      AND column_name = 'sent_message_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue ADD COLUMN sent_message_id TEXT';
  END IF;
END $$;

ALTER TABLE IF EXISTS public.downsells_queue
  ALTER COLUMN attempt_count SET DEFAULT 0;

ALTER TABLE IF EXISTS public.downsells_queue
  ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE IF EXISTS public.bot_settings
  ADD COLUMN IF NOT EXISTS public_base_url TEXT;

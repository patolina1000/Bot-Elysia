DO $$
BEGIN
  -- created_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='funnel_events' AND column_name='created_at'
  ) THEN
    ALTER TABLE public.funnel_events ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  END IF;

  -- occurred_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='funnel_events' AND column_name='occurred_at'
  ) THEN
    ALTER TABLE public.funnel_events ADD COLUMN occurred_at timestamptz NOT NULL DEFAULT now();
    UPDATE public.funnel_events SET occurred_at = created_at WHERE occurred_at IS NULL;
  END IF;

  -- índice occurred_at
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='funnel_events' AND indexname='ix_funnel_occurred_at'
  ) THEN
    CREATE INDEX ix_funnel_occurred_at ON public.funnel_events (occurred_at);
  END IF;

  -- dropar índice antigo em created_at (se existir)
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='funnel_events' AND indexname='ix_funnel_created_at'
  ) THEN
    DROP INDEX IF EXISTS ix_funnel_created_at;
  END IF;
END
$$;

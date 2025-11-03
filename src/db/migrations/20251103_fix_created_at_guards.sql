-- 20251103_fix_created_at_guards.sql
-- Ensure created_at column and occurred_at index exist safely

DO $$
BEGIN
  -- garante created_at em funnel_events
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='funnel_events' AND column_name='created_at'
  ) THEN
    ALTER TABLE public.funnel_events ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  END IF;

  -- índice de occurred_at (caso ainda não exista)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='funnel_events' AND indexname='ix_funnel_occurred_at'
  ) THEN
    CREATE INDEX ix_funnel_occurred_at ON public.funnel_events (occurred_at);
  END IF;
END
$$;

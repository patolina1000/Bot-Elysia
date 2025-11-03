-- 001c_add_created_at.sql
-- Garante created_at nas tabelas usadas pelos índices

-- funnel_events.created_at
ALTER TABLE IF EXISTS public.funnel_events
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE public.funnel_events
SET created_at = COALESCE(created_at, now());
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'funnel_events'
      AND column_name = 'created_at'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.funnel_events ALTER COLUMN created_at SET DEFAULT now()';
    EXECUTE 'ALTER TABLE IF EXISTS public.funnel_events ALTER COLUMN created_at SET NOT NULL';
  END IF;
END; $$;

-- app_logs.created_at
ALTER TABLE IF EXISTS public.app_logs
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE public.app_logs
SET created_at = COALESCE(created_at, now());
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'app_logs'
      AND column_name = 'created_at'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.app_logs ALTER COLUMN created_at SET DEFAULT now()';
    EXECUTE 'ALTER TABLE IF EXISTS public.app_logs ALTER COLUMN created_at SET NOT NULL';
  END IF;
END; $$;

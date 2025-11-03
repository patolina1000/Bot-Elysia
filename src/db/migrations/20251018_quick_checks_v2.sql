-- Migration: 001f_quick_checks.sql
-- Propósito: checagens rápidas e compat de schema. Idempotente.

-- 1) Renomear event_name -> event (se existir)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='funnel_events'
      AND column_name='event_name'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.funnel_events RENAME COLUMN event_name TO event';
  END IF;
END; $$;

-- 2) Garantir colunas de data/compat
ALTER TABLE IF EXISTS public.funnel_events
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS occurred_at  TIMESTAMPTZ DEFAULT now();

-- 3) Garantir índices em funnel_events
CREATE UNIQUE INDEX IF NOT EXISTS ux_funnel_event_id   ON public.funnel_events(event_id);
CREATE INDEX IF NOT EXISTS ix_funnel_event            ON public.funnel_events(event);
CREATE INDEX IF NOT EXISTS ix_funnel_created_at       ON public.funnel_events(created_at);
CREATE INDEX IF NOT EXISTS ix_funnel_occurred_at      ON public.funnel_events(occurred_at);

-- 4) UNIQUE (bot_id, tg_user_id) em users, somente se colunas existirem
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='users'
      AND column_name IN ('bot_id','tg_user_id')
    GROUP BY table_schema, table_name
    HAVING COUNT(*) = 2
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_bot_tg ON public.users(bot_id, tg_user_id)';
  END IF;
END; $$;


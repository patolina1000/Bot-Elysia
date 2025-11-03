-- 20251103_core_indexes_and_pgcrypto.sql
-- Garante extensão pgcrypto e índices/constraints essenciais de forma idempotente.

-- 1) Extensão pgcrypto (para pgp_sym_encrypt)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2) Índice único em funnel_events(event_id)
-- Aceitamos que já exista como 'ux_funnel_event_id' ou 'idx_funnel_events_event_id' (nome legado).
DO $$
DECLARE
  have_named boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM pg_indexes 
    WHERE schemaname='public' AND tablename='funnel_events'
      AND indexname IN ('ux_funnel_event_id','idx_funnel_events_event_id')
  )
  INTO have_named;

  IF NOT have_named THEN
    -- Garante pelo menos um índice único correto
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS ux_funnel_event_id ON public.funnel_events(event_id)';
  END IF;
END;
$$;

-- 3) Índice único em bots(slug)
CREATE UNIQUE INDEX IF NOT EXISTS ux_bots_slug ON public.bots(slug);

-- 4) Índice único em users(bot_id, tg_user_id) — só cria se as colunas existirem
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

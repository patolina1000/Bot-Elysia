-- 003_fix_downsells_queue_deliver_at.sql
-- Idempotente: só adiciona o que falta
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'downsells_queue'
  ) THEN
    -- Cria tabela caso não exista (estrutura mínima usada pelo worker)
    EXECUTE $DDL$
      CREATE TABLE public.downsells_queue (
        id              BIGSERIAL PRIMARY KEY,
        bot_slug        TEXT NOT NULL,
        downsell_id     BIGINT NOT NULL,
        telegram_id     BIGINT NOT NULL,
        deliver_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        status          TEXT NOT NULL DEFAULT 'pending',
        attempt_count   INT  NOT NULL DEFAULT 0,
        last_error      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    $DDL$;
  END IF;

  -- Garante a coluna deliver_at se a tabela já existia sem ela
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'downsells_queue'
      AND column_name = 'deliver_at'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue
             ADD COLUMN deliver_at TIMESTAMPTZ NOT NULL DEFAULT now()';
  END IF;

  -- Índice por deliver_at (apenas pendentes)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ix_downsells_queue_deliver_at_pending'
  ) THEN
    EXECUTE 'CREATE INDEX ix_downsells_queue_deliver_at_pending
             ON public.downsells_queue (deliver_at)
             WHERE status = ''pending''';
  END IF;

  -- Unicidade por (bot_slug, downsell_id, telegram_id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_downsells_queue_unique'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_downsells_queue_unique
             ON public.downsells_queue (bot_slug, downsell_id, telegram_id)';
  END IF;
END $$;


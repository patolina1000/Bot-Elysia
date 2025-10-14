-- 20251014_fix_downsells_queue_deliver_at.sql
-- Torna o schema compatível com o worker de downsells.
-- Idempotente: cria a tabela se faltar; adiciona deliver_at e índices se faltarem.
DO $$
BEGIN
  -- Cria a tabela mínima, se não existir
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.tables
    WHERE  table_schema = 'public' AND table_name = 'downsells_queue'
  ) THEN
    EXECUTE $DDL$
      CREATE TABLE public.downsells_queue (
        id              BIGSERIAL PRIMARY KEY,
        bot_slug        TEXT NOT NULL,
        downsell_id     BIGINT NOT NULL,
        telegram_id     BIGINT NOT NULL,
        deliver_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        status          TEXT NOT NULL DEFAULT 'pending', -- pending|sent|skipped|error
        attempt_count   INT  NOT NULL DEFAULT 0,
        last_error      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    $DDL$;
  END IF;

  -- Garante a coluna deliver_at
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema='public' AND table_name='downsells_queue' AND column_name='deliver_at'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue
             ADD COLUMN deliver_at TIMESTAMPTZ NOT NULL DEFAULT now()';
  END IF;

  -- Índice por deliver_at apenas para pendentes (acelera o worker)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ix_downsells_queue_deliver_at_pending'
  ) THEN
    EXECUTE 'CREATE INDEX ix_downsells_queue_deliver_at_pending
             ON public.downsells_queue (deliver_at)
             WHERE status = ''pending''';
  END IF;

  -- Unicidade por bot+downsell+usuário (idempotência)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_downsells_queue_unique'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_downsells_queue_unique
             ON public.downsells_queue (bot_slug, downsell_id, telegram_id)';
  END IF;
END $$;


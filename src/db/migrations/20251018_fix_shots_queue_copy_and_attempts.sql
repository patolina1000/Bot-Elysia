-- 20251018_fix_shots_queue_copy_and_attempts.sql
-- Ajusta a schema de shots_queue para bater com o código (createShot + worker).

DO $$
BEGIN
  -- copy: texto do disparo
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='shots_queue' AND column_name='copy'
  ) THEN
    EXECUTE 'ALTER TABLE public.shots_queue ADD COLUMN copy TEXT NOT NULL DEFAULT '''';';
  END IF;

  -- target (garantia – você já adicionou, mas deixo idempotente)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='shots_queue' AND column_name='target'
  ) THEN
    EXECUTE 'ALTER TABLE public.shots_queue ADD COLUMN target TEXT NOT NULL DEFAULT ''started'';';
  END IF;

  -- constraint do target
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname='shots_queue' AND c.conname='shots_queue_target_check'
  ) THEN
    EXECUTE $$ALTER TABLE public.shots_queue
      ADD CONSTRAINT shots_queue_target_check
      CHECK (target IN ('started','pix_created'));$$;
  END IF;

  -- campos usados pelo worker
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='shots_queue' AND column_name='attempt_count'
  ) THEN
    EXECUTE 'ALTER TABLE public.shots_queue ADD COLUMN attempt_count INT NOT NULL DEFAULT 0;';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='shots_queue' AND column_name='last_error'
  ) THEN
    EXECUTE 'ALTER TABLE public.shots_queue ADD COLUMN last_error TEXT;';
  END IF;

  -- índice útil para o worker (pegar apenas pendentes e por horário)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_shots_queue_pending_scheduled'
  ) THEN
    EXECUTE $$CREATE INDEX idx_shots_queue_pending_scheduled
             ON public.shots_queue (scheduled_at)
             WHERE status = 'pending';$$;
  END IF;
END $$;

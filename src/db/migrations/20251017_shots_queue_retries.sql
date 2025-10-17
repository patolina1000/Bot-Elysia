-- Retentativas para shots_queue
-- Adiciona attempt_count e last_error se não existirem.
-- Mantém compatível com bases já rodando.

BEGIN;

ALTER TABLE public.shots_queue
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error   text;

-- Índice útil quando houver muitas linhas 'scheduled'
-- (se já tiver ix_shots_queue_due, pode manter ambos)
CREATE INDEX IF NOT EXISTS ix_shots_queue_scheduled_only
  ON public.shots_queue (deliver_at)
  WHERE status = 'scheduled';

-- Opcional: acelerar consultas por status isolado
CREATE INDEX IF NOT EXISTS ix_shots_queue_status
  ON public.shots_queue (status);

COMMIT;

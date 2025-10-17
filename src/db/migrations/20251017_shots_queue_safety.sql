-- Garante de-duplicação e melhora o desempenho do scheduler/worker
BEGIN;

-- 1) De-duplicação por (shot_id, telegram_id)
--    Permite que o INSERT ... ON CONFLICT DO NOTHING funcione de fato.
CREATE UNIQUE INDEX IF NOT EXISTS ux_shots_queue_shot_telegram
  ON public.shots_queue (shot_id, telegram_id);

-- 2) Índice para captura de jobs vencidos/pontuais
--    (o worker normalmente faz WHERE status='scheduled' AND deliver_at <= NOW())
CREATE INDEX IF NOT EXISTS ix_shots_queue_due
  ON public.shots_queue (status, deliver_at);

-- 3) (Opcional) Índice para reprocessamento/observabilidade por shot
CREATE INDEX IF NOT EXISTS ix_shots_queue_by_shot
  ON public.shots_queue (shot_id, status);

-- 4) Defaults seguros (não falham se a coluna não existir)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='shots_queue' AND column_name='attempt_count') THEN
    EXECUTE 'ALTER TABLE public.shots_queue ALTER COLUMN attempt_count SET DEFAULT 0';
  END IF;
END $$ LANGUAGE plpgsql;

COMMIT;

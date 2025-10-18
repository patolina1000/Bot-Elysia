-- Ajusta a schema de shots_queue para bater com o código (createShot + worker).

-- Colunas que o código usa
ALTER TABLE public.shots_queue
  ADD COLUMN IF NOT EXISTS copy TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'started',
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Garante a constraint do target (started | pix_created)
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'shots_queue'
      AND c.conname = 'shots_queue_target_check'
  ) THEN
    EXECUTE 'ALTER TABLE public.shots_queue
             ADD CONSTRAINT shots_queue_target_check
             CHECK (target IN (''started'',''pix_created''))';
  END IF;
END
$do$;

-- Índice parcial para o worker (pendentes por horário)
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_shots_queue_pending_scheduled'
  ) THEN
    EXECUTE 'CREATE INDEX idx_shots_queue_pending_scheduled
             ON public.shots_queue (scheduled_at)
             WHERE status = ''pending''';
  END IF;
END
$do$;

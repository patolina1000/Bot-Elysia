-- Índice para acelerar o picker do worker em status 'scheduled'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname  = 'idx_downsells_queue_deliver_at_scheduled'
  ) THEN
    EXECUTE 'CREATE INDEX idx_downsells_queue_deliver_at_scheduled
             ON public.downsells_queue (deliver_at)
             WHERE status = ''scheduled''';
  END IF;
END $$;

-- Opcional: manter o índice antigo de 'pending' por compatibilidade/histórico.
-- Para remover no futuro (opcional), rodar:
-- DROP INDEX IF EXISTS public.idx_downsells_queue_deliver_at_pending;

-- Ajuste robusto da FK de downsells_queue -> bot_downsells(id)
-- Estratégia:
-- 1) Drop da FK antiga (se existir)
-- 2) Criar a nova FK como NOT VALID (não checa linhas existentes)
-- 3) Remover órfãos em downsells_queue
-- 4) VALIDATE CONSTRAINT

DO $$
BEGIN
  -- Garante que a tabela de destino existe
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'bot_downsells'
  ) THEN
    RAISE EXCEPTION 'Tabela public.bot_downsells não encontrada; não é possível criar FK.';
  END IF;

  -- Dropa a FK antiga (se existir)
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'downsells_queue'
      AND c.conname = 'downsells_queue_downsell_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue DROP CONSTRAINT downsells_queue_downsell_id_fkey';
  END IF;
END $$;

-- Cria a nova FK como NOT VALID para não falhar por linhas antigas
ALTER TABLE public.downsells_queue
  ADD CONSTRAINT downsells_queue_downsell_id_fkey
  FOREIGN KEY (downsell_id)
  REFERENCES public.bot_downsells(id)
  ON DELETE CASCADE
  NOT VALID;

-- Remove órfãos: filas apontando para downsell inexistente
DELETE FROM public.downsells_queue q
WHERE NOT EXISTS (
  SELECT 1 FROM public.bot_downsells d
  WHERE d.id = q.downsell_id
);

-- Agora valida a constraint com o conjunto já saneado
ALTER TABLE public.downsells_queue
  VALIDATE CONSTRAINT downsells_queue_downsell_id_fkey;

-- (Opcional) Índices úteis se ainda não existirem
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND indexname='idx_downsells_queue_status_deliver_at'
  ) THEN
    EXECUTE 'CREATE INDEX idx_downsells_queue_status_deliver_at ON public.downsells_queue(status, deliver_at)';
  END IF;
END $$;

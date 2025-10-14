-- Corrige a foreign key de downsells_queue:
-- antes: downsells_queue(downsell_id) -> public.downsells(id)
-- agora: downsells_queue(downsell_id) -> public.bot_downsells(id)
DO $$
BEGIN
  -- 0) Checagem opcional de órfãos (apenas para log em migração)
  RAISE NOTICE 'Verificando possíveis órfãos em downsells_queue...';
  PERFORM 1
    FROM public.downsells_queue q
    LEFT JOIN public.bot_downsells d ON d.id = q.downsell_id
    WHERE d.id IS NULL;
  -- Se existirem órfãos reais, a criação da FK falhará e você verá o erro.

  -- 1) Dropa a FK antiga, se existir
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'downsells_queue'
      AND c.conname = 'downsells_queue_downsell_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE public.downsells_queue DROP CONSTRAINT downsells_queue_downsell_id_fkey';
  END IF;

  -- 2) Cria a nova FK apontando para bot_downsells(id)
  EXECUTE '
    ALTER TABLE public.downsells_queue
    ADD CONSTRAINT downsells_queue_downsell_id_fkey
    FOREIGN KEY (downsell_id)
    REFERENCES public.bot_downsells(id)
    ON DELETE CASCADE
  ';
END $$;

-- Higiene: garantir PK/índice em bot_downsells.id (normalmente já é PK)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = 'bot_downsells'
      AND i.indisprimary
  ) THEN
    -- Se por acaso não existir PK, definimos.
    EXECUTE 'ALTER TABLE public.bot_downsells ADD PRIMARY KEY (id)';
  END IF;
END $$;

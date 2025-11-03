-- Corrige/garante scheduled_at na fila de downsells:
-- 1) Backfill de valores nulos
-- 2) DEFAULT now()
-- 3) NOT NULL
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'downsells_queue'
       AND column_name  = 'scheduled_at'
  ) THEN
    -- Cria coluna se não existir
    EXECUTE 'ALTER TABLE IF EXISTS public.downsells_queue ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ';
    -- Preenche linhas antigas
    EXECUTE 'UPDATE public.downsells_queue SET scheduled_at = COALESCE(created_at, NOW()) WHERE scheduled_at IS NULL';
    -- Define default e not null
    EXECUTE 'ALTER TABLE IF EXISTS public.downsells_queue ALTER COLUMN scheduled_at SET DEFAULT NOW()';
    EXECUTE 'ALTER TABLE IF EXISTS public.downsells_queue ALTER COLUMN scheduled_at SET NOT NULL';
  ELSE
    -- Já existe: backfill + default + not null
    EXECUTE 'UPDATE public.downsells_queue SET scheduled_at = COALESCE(scheduled_at, created_at, NOW()) WHERE scheduled_at IS NULL';
    EXECUTE 'ALTER TABLE IF EXISTS public.downsells_queue ALTER COLUMN scheduled_at SET DEFAULT NOW()';
    BEGIN
      EXECUTE 'ALTER TABLE IF EXISTS public.downsells_queue ALTER COLUMN scheduled_at SET NOT NULL';
    EXCEPTION WHEN OTHERS THEN
      -- Se por algum motivo ainda houver nulos, não interrompa deploy
      NULL;
    END;
  END IF;
END; $$;

-- Higiene opcional (garante defaults de outras colunas já existentes)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'downsells_queue'
      AND column_name = 'attempt_count'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.downsells_queue ALTER COLUMN attempt_count SET DEFAULT 0';
  END IF;
END; $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'downsells_queue'
      AND column_name = 'updated_at'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.downsells_queue ALTER COLUMN updated_at SET DEFAULT now()';
  END IF;
END; $$;

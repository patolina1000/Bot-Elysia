-- Adiciona plan_id ao cadastro de downsell e cria FK para bot_plans(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='bot_downsells' AND column_name='plan_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.bot_downsells ADD COLUMN plan_id INTEGER NULL';
  END IF;

  -- Cria FK se não existir
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = ''bot_downsells'' AND c.conname = ''bot_downsells_plan_id_fkey''
  ) THEN
    EXECUTE '
      ALTER TABLE public.bot_downsells
        ADD CONSTRAINT bot_downsells_plan_id_fkey
        FOREIGN KEY (plan_id)
        REFERENCES public.bot_plans(id)
        ON DELETE SET NULL
    ';
  END IF;
END $$;

-- Índice de ajuda para consultas por bot/plan
CREATE INDEX IF NOT EXISTS idx_bot_downsells_bot_slug_plan_id ON public.bot_downsells(bot_slug, plan_id);

-- Permite price_cents opcional quando houver plan_id
ALTER TABLE public.bot_downsells ALTER COLUMN price_cents DROP NOT NULL;

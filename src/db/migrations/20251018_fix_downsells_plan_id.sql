-- Garante plan_id em bot_downsells, FK com bot_plans(id), índice de apoio
DO $$
BEGIN
  -- Coluna plan_id (nullable)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bot_downsells' AND column_name='plan_id'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.bot_downsells ADD COLUMN IF NOT EXISTS plan_id INTEGER NULL';
  END IF;

  -- FK bot_downsells.plan_id -> bot_plans(id)
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'bot_downsells' AND c.conname = 'bot_downsells_plan_id_fkey'
  ) THEN
    EXECUTE '
      ALTER TABLE IF EXISTS public.bot_downsells
        ADD CONSTRAINT bot_downsells_plan_id_fkey
        FOREIGN KEY (plan_id)
        REFERENCES public.bot_plans(id)
        ON DELETE SET NULL
    ';
  END IF;

  -- price_cents não-obrigatório quando existir plan_id
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bot_downsells'
      AND column_name='price_cents' AND is_nullable = 'NO'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.bot_downsells ALTER COLUMN price_cents DROP NOT NULL';
  END IF;
END; $$;

-- Índice para consultas por bot/plan
CREATE INDEX IF NOT EXISTS idx_bot_downsells_bot_slug_plan_id
  ON public.bot_downsells (bot_slug, plan_id);

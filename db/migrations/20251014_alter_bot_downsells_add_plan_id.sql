-- 20251014_alter_bot_downsells_add_plan_id.sql
-- Adiciona plan_id em bot_downsells e cria FK para bot_plans(id).
-- Idempotente: pode rodar mais de uma vez.

-- 1) Coluna (se ainda não existir)
ALTER TABLE public.bot_downsells
  ADD COLUMN IF NOT EXISTS plan_id INTEGER;

-- 2) FK (derruba a antiga, se houver, e recria apontando p/ bot_plans)
ALTER TABLE public.bot_downsells
  DROP CONSTRAINT IF EXISTS bot_downsells_plan_id_fkey;

ALTER TABLE public.bot_downsells
  ADD CONSTRAINT bot_downsells_plan_id_fkey
  FOREIGN KEY (plan_id)
  REFERENCES public.bot_plans(id)
  ON DELETE SET NULL;

-- 3) Índice auxiliar
CREATE INDEX IF NOT EXISTS idx_bot_downsells_bot_slug_plan_id
  ON public.bot_downsells (bot_slug, plan_id);

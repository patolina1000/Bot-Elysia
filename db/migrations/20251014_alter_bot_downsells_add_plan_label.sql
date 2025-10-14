-- 20251014_alter_bot_downsells_add_plan_label.sql
-- Campo textual para o nome do botão (plano) do downsell
ALTER TABLE public.bot_downsells
  ADD COLUMN IF NOT EXISTS plan_label TEXT;

-- Opcional: pequena ajuda para buscas
CREATE INDEX IF NOT EXISTS idx_bot_downsells_plan_label
  ON public.bot_downsells (bot_slug, plan_label);

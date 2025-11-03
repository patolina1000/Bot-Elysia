-- Campo textual para o nome do botão (plano) do downsell
ALTER TABLE IF EXISTS public.bot_downsells
  ADD COLUMN IF NOT EXISTS plan_label TEXT;

-- Ajuda para buscas por bot e plan_label
CREATE INDEX IF NOT EXISTS idx_bot_downsells_plan_label
  ON public.bot_downsells (bot_slug, plan_label);

-- Adiciona coluna JSONB para planos extras
ALTER TABLE public.bot_downsells
ADD COLUMN IF NOT EXISTS extra_plans JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Índice GIN para consultas futuras (opcional, barato)
CREATE INDEX IF NOT EXISTS ix_bot_downsells_extra_plans_gin
  ON public.bot_downsells
  USING GIN (extra_plans);

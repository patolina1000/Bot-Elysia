-- 1) Garantir default/índice do extra_plans (barato e útil p/ métricas)
ALTER TABLE public.bot_downsells
  ALTER COLUMN extra_plans SET DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS ix_bot_downsells_extra_plans_gin
  ON public.bot_downsells USING GIN (extra_plans);

-- 2) Enriquecer downsells_sent com dados do plano escolhido
ALTER TABLE public.downsells_sent
  ADD COLUMN IF NOT EXISTS sent_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS plan_label TEXT,
  ADD COLUMN IF NOT EXISTS price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

-- 3) (Opcional mas recomendado) Garantir meta na tabela de transações
--    Caso ainda não exista:
ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS ix_payment_transactions_meta_gin
  ON public.payment_transactions USING GIN (meta);

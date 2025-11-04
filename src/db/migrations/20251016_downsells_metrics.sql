-- 1) Garantir default/índice do extra_plans (barato e útil p/ métricas)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bot_downsells'
      AND column_name = 'extra_plans'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.bot_downsells ALTER COLUMN extra_plans SET DEFAULT ''[]''::jsonb';
  END IF;
END; $$;

CREATE INDEX IF NOT EXISTS ix_bot_downsells_extra_plans_gin
  ON public.bot_downsells USING GIN (extra_plans);

-- 2) Enriquecer downsells_sent com dados do plano escolhido
ALTER TABLE IF EXISTS public.downsells_sent
  ADD COLUMN IF NOT EXISTS sent_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS plan_label TEXT,
  ADD COLUMN IF NOT EXISTS price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

-- 3) (Opcional mas recomendado) Garantir meta na tabela de transações
--    Caso ainda não exista:
ALTER TABLE IF EXISTS public.payment_transactions
  ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'payment_transactions'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_payment_transactions_meta_gin
      ON public.payment_transactions USING GIN (meta)';
  END IF;
END; $$;

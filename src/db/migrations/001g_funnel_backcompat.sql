-- Garante colunas opcionais usadas por FunnelService e índices comuns. Idempotente.

ALTER TABLE IF EXISTS public.funnel_events
  ADD COLUMN IF NOT EXISTS price_cents    INTEGER,
  ADD COLUMN IF NOT EXISTS session_id     TEXT,
  ADD COLUMN IF NOT EXISTS payload_id     TEXT,
  ADD COLUMN IF NOT EXISTS transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS meta           JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS ix_funnel_tg_user_id  ON public.funnel_events(tg_user_id);
CREATE INDEX IF NOT EXISTS ix_funnel_bot_id      ON public.funnel_events(bot_id);
CREATE INDEX IF NOT EXISTS ix_funnel_transaction ON public.funnel_events(transaction_id);

-- 20251017_a_guard_funnel_events_occurred_at.sql
-- Garante que funnel_events.occurred_at exista antes do backfill de contatos do Telegram.

ALTER TABLE IF EXISTS public.funnel_events
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;

-- Preenche valores ausentes reaproveitando created_at, preservando registros válidos.
UPDATE public.funnel_events
   SET occurred_at = created_at
 WHERE occurred_at IS NULL
   AND created_at IS NOT NULL;

-- Define default para novos registros, mas evita sobrescrever caso já exista.
ALTER TABLE IF EXISTS public.funnel_events
  ALTER COLUMN occurred_at SET DEFAULT now();

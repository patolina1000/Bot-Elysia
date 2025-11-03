-- 20251103_align_funnel_events_occurred_at.sql
-- Padroniza funnel_events para usar occurred_at nas métricas e remove índice antigo de created_at.

-- Garante coluna occurred_at com default (caso algum ambiente ainda não tenha)
ALTER TABLE IF EXISTS public.funnel_events
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ DEFAULT now();

-- Backfill defensivo: se existir algum registro sem occurred_at, usa created_at
UPDATE public.funnel_events
   SET occurred_at = created_at
 WHERE occurred_at IS NULL
   AND created_at IS NOT NULL;

-- Índice por occurred_at (simples)
CREATE INDEX IF NOT EXISTS ix_funnel_occurred_at
  ON public.funnel_events (occurred_at);

-- Índice composto event + occurred_at (para séries e filtros por evento)
CREATE INDEX IF NOT EXISTS idx_funnel_events_event_occurred_at
  ON public.funnel_events (event, occurred_at);

-- Opcional: remove índice antigo por created_at para evitar bloat / planner confuso
DROP INDEX IF EXISTS ix_funnel_created_at;

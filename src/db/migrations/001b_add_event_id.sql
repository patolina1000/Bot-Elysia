-- garante a coluna e preenche para linhas antigas
ALTER TABLE IF EXISTS public.funnel_events
  ADD COLUMN IF NOT EXISTS event_id TEXT;

UPDATE public.funnel_events
SET event_id = COALESCE(event_id, 'ev:' || id::text)
WHERE event_id IS NULL;

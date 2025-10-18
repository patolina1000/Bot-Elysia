-- 20251107_align_funnel_events_event.sql
-- Alinha a coluna de evento e índices para utilizar "event" em funnel_events.

DO $$
DECLARE
  v_event_exists BOOLEAN;
  v_event_name_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'funnel_events'
      AND column_name = 'event'
  ) INTO v_event_exists;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'funnel_events'
      AND column_name = 'event_name'
  ) INTO v_event_name_exists;

  IF NOT v_event_exists AND v_event_name_exists THEN
    EXECUTE 'ALTER TABLE public.funnel_events RENAME COLUMN event_name TO event';
  END IF;
END $$;

-- Remove índices antigos que ainda apontem para event_name.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'funnel_events'
      AND indexdef ILIKE '%event_name%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', rec.indexname);
  END LOOP;
END $$;

-- Garante os índices atualizados para a coluna event.
CREATE INDEX IF NOT EXISTS idx_funnel_events_event
  ON public.funnel_events (event);

CREATE INDEX IF NOT EXISTS idx_funnel_events_event_occurred_at
  ON public.funnel_events (event, occurred_at);

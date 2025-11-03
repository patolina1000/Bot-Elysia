DO $$
BEGIN
  -- coluna event_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='funnel_events' AND column_name='event_id'
  ) THEN
    ALTER TABLE public.funnel_events ADD COLUMN event_id TEXT;
  END IF;

  -- NOT NULL (só se não houver nulos; em banco novo passa sem erro)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='funnel_events'
      AND column_name='event_id' AND is_nullable='YES'
  ) THEN
    ALTER TABLE public.funnel_events ALTER COLUMN event_id SET NOT NULL;
  END IF;

  -- índice/constraint de dedup
  PERFORM 1 FROM pg_indexes
   WHERE schemaname='public' AND tablename='funnel_events'
     AND (indexname='ux_funnel_events_event_id' OR indexdef ILIKE '%(event_id)%');
  IF NOT FOUND THEN
    CREATE UNIQUE INDEX IF NOT EXISTS ux_funnel_events_event_id
      ON public.funnel_events (event_id);
  END IF;
END
$$;

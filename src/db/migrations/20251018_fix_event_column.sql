-- Garante que public.funnel_events tenha coluna "event" (renomeia de event_name se necessário)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='funnel_events' AND column_name='event'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='funnel_events' AND column_name='event_name'
    ) THEN
      EXECUTE 'ALTER TABLE public.funnel_events RENAME COLUMN event_name TO event';
    ELSE
      EXECUTE 'ALTER TABLE public.funnel_events ADD COLUMN event TEXT';
    END IF;
  END IF;

  -- saneamento para linhas antigas: evita NULL/'' em event
  EXECUTE
    'UPDATE public.funnel_events
       SET event = COALESCE(NULLIF(event, ''''), ''unknown'')
     WHERE event IS NULL OR event = ''''';
    ';
END; $$;

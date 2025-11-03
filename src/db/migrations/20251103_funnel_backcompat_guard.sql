DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='funnel_events' AND column_name='price_cents') THEN
    ALTER TABLE public.funnel_events ADD COLUMN price_cents int;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='funnel_events' AND column_name='meta') THEN
    ALTER TABLE public.funnel_events ADD COLUMN meta jsonb;
  END IF;

  PERFORM 1
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relname='funnel_events' AND t.tgname='trg_funnel_events_legacy_ip';
  IF FOUND THEN
    DROP TRIGGER IF EXISTS trg_funnel_events_legacy_ip ON public.funnel_events;
  END IF;

  BEGIN
    ALTER TABLE public.funnel_events ALTER COLUMN event_name SET NOT NULL;
  EXCEPTION WHEN others THEN
    -- ignora se houver dados antigos inconsistentes
  END;
END
$$;

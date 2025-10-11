-- 0) Padroniza a tabela dos contadores
CREATE TABLE IF NOT EXISTS public.funnel_counters (
  event_name TEXT PRIMARY KEY,
  counter    BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Se a tabela já existia com coluna "event", renomeia p/ event_name
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='funnel_counters' AND column_name='event'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='funnel_counters' AND column_name='event_name'
  ) THEN
    EXECUTE 'ALTER TABLE public.funnel_counters RENAME COLUMN event TO event_name';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_funnel_counters_event ON public.funnel_counters(event_name);

-- 1) Recria a função usando NEW.event (com fallback via JSON p/ compat)
CREATE OR REPLACE FUNCTION public.fn_update_funnel_counters()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_event TEXT;
BEGIN
  -- prefere NEW.event; fallback para chave antiga caso exista
  v_event := COALESCE(NEW.event, (to_jsonb(NEW)->>'event_name'));

  IF v_event IS NULL OR v_event = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.funnel_counters (event_name, counter, updated_at)
  VALUES (v_event, 1, NOW())
  ON CONFLICT (event_name) DO UPDATE
    SET counter = public.funnel_counters.counter + 1,
        updated_at = NOW();

  RETURN NEW;
END $$;

-- 2) Garante o trigger apontando para a função nova
DROP TRIGGER IF EXISTS trg_update_funnel_counters ON public.funnel_events;
CREATE TRIGGER trg_update_funnel_counters
AFTER INSERT ON public.funnel_events
FOR EACH ROW
EXECUTE FUNCTION public.fn_update_funnel_counters();

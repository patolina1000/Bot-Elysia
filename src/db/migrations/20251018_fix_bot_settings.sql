CREATE TABLE IF NOT EXISTS public.bot_settings (
  bot_slug       TEXT PRIMARY KEY,
  pix_image_url  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'trg_set_updated_at' AND n.nspname = 'public'
  ) THEN
    CREATE OR REPLACE FUNCTION public.trg_set_updated_at()
    RETURNS trigger
    AS $body$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $body$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at_on_bot_settings ON public.bot_settings;
CREATE TRIGGER set_updated_at_on_bot_settings
BEFORE UPDATE ON public.bot_settings
FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();

BEGIN;

ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS pix_downsell_text TEXT,
  ADD COLUMN IF NOT EXISTS offers_text TEXT;

COMMIT;

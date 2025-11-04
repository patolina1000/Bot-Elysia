-- Ensure shot target enum exists
DO $$ BEGIN
  CREATE TYPE shot_target_enum AS ENUM ('started', 'pix_created');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Ensure shot status enum exists
DO $$ BEGIN
  CREATE TYPE shot_status_enum AS ENUM ('pending', 'running', 'sent', 'skipped', 'error');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create shots_queue table if missing so subsequent migrations (e.g. shots_sent)
-- can safely reference it. This mirrors the original queue schema that later
-- migrations reshape into the per-recipient layout.
CREATE TABLE IF NOT EXISTS public.shots_queue (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  target shot_target_enum NOT NULL,
  copy TEXT NOT NULL,
  media_url TEXT,
  media_type TEXT CHECK (media_type IN ('photo', 'video', 'audio', 'none')),
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status shot_status_enum NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guarantee scheduled_at column is present even on legacy databases
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'scheduled_at'
  ) THEN
    EXECUTE 'ALTER TABLE public.shots_queue ADD COLUMN scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now()';
  END IF;
END $$;

-- Drop obsolete indexes that might reference outdated column names
DROP INDEX IF EXISTS idx_shots_queue_deliver_at;
DROP INDEX IF EXISTS idx_shots_queue_deliver_at_pending;
DROP INDEX IF EXISTS idx_shots_queue_status_deliver_at;

-- Indexes used by the worker to fetch pending jobs and filter by bot
CREATE INDEX IF NOT EXISTS idx_shots_queue_scheduled
  ON public.shots_queue (status, scheduled_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_shots_queue_slug
  ON public.shots_queue (bot_slug, status, scheduled_at DESC);

-- Trigger to keep updated_at fresh on every update
CREATE OR REPLACE FUNCTION public.update_shots_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shots_queue_updated_at_trigger ON public.shots_queue;
CREATE TRIGGER shots_queue_updated_at_trigger
  BEFORE UPDATE ON public.shots_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.update_shots_queue_updated_at();

-- Create enum for shot targets
DO $$ BEGIN
  CREATE TYPE shot_target_enum AS ENUM ('started', 'pix_created');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create enum for shot status
DO $$ BEGIN
  CREATE TYPE shot_status_enum AS ENUM ('pending', 'running', 'sent', 'skipped', 'error');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create shots_queue table
CREATE TABLE IF NOT EXISTS shots_queue (
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

-- Create indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_shots_queue_scheduled 
  ON shots_queue (status, scheduled_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_shots_queue_slug 
  ON shots_queue (bot_slug, status, scheduled_at DESC);

-- Create trigger to automatically update updated_at
CREATE OR REPLACE FUNCTION update_shots_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shots_queue_updated_at_trigger ON shots_queue;
CREATE TRIGGER shots_queue_updated_at_trigger
  BEFORE UPDATE ON shots_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_shots_queue_updated_at();

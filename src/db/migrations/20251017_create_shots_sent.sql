-- Create shots_sent table for audit and fine-grained retries
CREATE TABLE IF NOT EXISTS shots_sent (
  shot_id BIGINT NOT NULL REFERENCES shots_queue(id) ON DELETE CASCADE,
  bot_slug TEXT NOT NULL,
  telegram_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'skipped', 'error')),
  error TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shot_id, telegram_id)
);

-- Idempotent protection: ensure status column exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_sent'
      AND column_name = 'status'
  ) THEN
    EXECUTE 'ALTER TABLE IF EXISTS public.shots_sent ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT ''sent'' CHECK (status IN (''sent'', ''skipped'', ''error''))';
  END IF;
END; $$;

-- Drop any potentially broken indexes that might reference wrong column names
DROP INDEX IF EXISTS idx_shots_sent_deliver_status;
DROP INDEX IF EXISTS idx_shots_sent_result;

-- Create indexes for optimal query performance
-- Required: index on shot_id for foreign key and joins
CREATE INDEX IF NOT EXISTS idx_shots_sent_shot_id 
  ON shots_sent (shot_id);

-- Required: index on bot_slug and sent_at for audit queries
CREATE INDEX IF NOT EXISTS idx_shots_sent_bot_slug_sent_at 
  ON shots_sent (bot_slug, sent_at DESC);

-- Optional: partial index for error queries
CREATE INDEX IF NOT EXISTS idx_shots_sent_errors
  ON shots_sent (shot_id, telegram_id, sent_at)
  WHERE status = 'error';

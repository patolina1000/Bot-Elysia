-- Create shots_sent table for audit and fine-grained retries
CREATE TABLE IF NOT EXISTS shots_sent (
  shot_id BIGINT NOT NULL REFERENCES shots_queue(id) ON DELETE CASCADE,
  bot_slug TEXT NOT NULL,
  telegram_id BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'error')),
  error TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shot_id, telegram_id)
);

-- Create indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_shots_sent_shot_id 
  ON shots_sent (shot_id, status);

CREATE INDEX IF NOT EXISTS idx_shots_sent_slug_time 
  ON shots_sent (bot_slug, sent_at DESC);

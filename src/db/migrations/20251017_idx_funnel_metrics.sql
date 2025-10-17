-- Index to optimize chat metrics queries
-- This index helps with queries that filter by bot_id and tg_user_id,
-- and need to find the maximum occurred_at per user

-- Create composite index for metrics queries
CREATE INDEX IF NOT EXISTS ix_funnel_bot_tguser_occurred 
  ON funnel_events(bot_id, tg_user_id, occurred_at DESC)
  WHERE tg_user_id IS NOT NULL;

-- Additional index for efficient bot_id lookups when tg_user_id is present
CREATE INDEX IF NOT EXISTS ix_funnel_bot_tguser 
  ON funnel_events(bot_id, tg_user_id)
  WHERE tg_user_id IS NOT NULL;

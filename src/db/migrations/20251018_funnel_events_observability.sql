-- Ensure event_id has a unique index for idempotent inserts
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_events_event_id
  ON funnel_events (event_id);

CREATE INDEX IF NOT EXISTS idx_funnel_events_event_name
  ON funnel_events (event_name);

CREATE INDEX IF NOT EXISTS idx_funnel_events_event_name_time
  ON funnel_events (event_name, occurred_at);

CREATE INDEX IF NOT EXISTS idx_funnel_events_bot_slug
  ON funnel_events ((meta->>'bot_slug'));

CREATE INDEX IF NOT EXISTS idx_funnel_events_shot_id
  ON funnel_events ((meta->>'shot_id'));

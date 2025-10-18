-- acelerar joins por payload_id
CREATE INDEX IF NOT EXISTS idx_funnel_events_payload_id ON funnel_events(payload_id);
CREATE INDEX IF NOT EXISTS idx_payload_tracking_payload_id ON payload_tracking(payload_id);
-- já deve existir índice em telegram_id; se não:
CREATE INDEX IF NOT EXISTS idx_payload_tracking_telegram_id ON payload_tracking(telegram_id);

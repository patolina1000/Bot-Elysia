-- 001c_add_created_at.sql
-- Garante created_at nas tabelas usadas pelos índices

-- funnel_events.created_at
ALTER TABLE IF EXISTS funnel_events
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE funnel_events
SET created_at = COALESCE(created_at, now());
ALTER TABLE IF EXISTS funnel_events
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL;

-- app_logs.created_at
ALTER TABLE IF EXISTS app_logs
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE app_logs
SET created_at = COALESCE(created_at, now());
ALTER TABLE IF EXISTS app_logs
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL;

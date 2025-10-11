CREATE UNIQUE INDEX IF NOT EXISTS ux_bots_slug ON bots(slug);
CREATE UNIQUE INDEX IF NOT EXISTS ux_funnel_event_id ON funnel_events(event_id);
CREATE INDEX IF NOT EXISTS ix_funnel_created_at ON funnel_events(created_at);
CREATE INDEX IF NOT EXISTS ix_funnel_event ON funnel_events(event);
CREATE INDEX IF NOT EXISTS ix_logs_created_at ON app_logs(created_at);
CREATE INDEX IF NOT EXISTS ix_logs_event_id ON app_logs((meta->>'event_id'));
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_bot_tg ON users(bot_id, tg_user_id);

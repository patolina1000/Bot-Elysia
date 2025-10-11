-- Insert funnel event (with ON CONFLICT DO NOTHING for idempotency)
-- INSERT INTO funnel_events (bot_id, tg_user_id, event, event_id, price_cents, transaction_id, meta)
-- VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id) DO NOTHING RETURNING *
-- $1: bot_id, $2: tg_user_id, $3: event, $4: event_id, $5: price_cents, $6: transaction_id, $7: meta

-- Get event by event_id
-- SELECT * FROM funnel_events WHERE event_id = $1
-- $1: event_id

-- Count events by type
-- SELECT event, COUNT(*) as count FROM funnel_events 
-- WHERE bot_id = $1 AND created_at >= $2 AND created_at <= $3
-- GROUP BY event
-- $1: bot_id, $2: from_date, $3: to_date

-- Timeseries by day
-- SELECT DATE_TRUNC($4, created_at) as period, event, COUNT(*) as count
-- FROM funnel_events
-- WHERE bot_id = $1 AND created_at >= $2 AND created_at <= $3
-- GROUP BY period, event ORDER BY period ASC
-- $1: bot_id, $2: from_date, $3: to_date, $4: granularity ('day' | 'hour')

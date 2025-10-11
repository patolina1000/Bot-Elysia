-- Insert app log
-- INSERT INTO app_logs (bot_id, level, request_id, message, meta)
-- VALUES ($1, $2, $3, $4, $5)
-- $1: bot_id, $2: level, $3: request_id, $4: message, $5: meta

-- Query logs with filters and pagination
-- SELECT * FROM app_logs
-- WHERE ($1::UUID IS NULL OR bot_id = $1)
--   AND ($2::TEXT IS NULL OR level = $2)
--   AND ($3::UUID IS NULL OR request_id = $3)
-- ORDER BY created_at DESC
-- LIMIT $4 OFFSET $5
-- $1: bot_id, $2: level, $3: request_id, $4: limit, $5: offset

-- Count logs with filters
-- SELECT COUNT(*) FROM app_logs
-- WHERE ($1::UUID IS NULL OR bot_id = $1)
--   AND ($2::TEXT IS NULL OR level = $2)
--   AND ($3::UUID IS NULL OR request_id = $3)
-- $1: bot_id, $2: level, $3: request_id

-- Delete old logs
-- DELETE FROM app_logs WHERE created_at < now() - interval '14 days'

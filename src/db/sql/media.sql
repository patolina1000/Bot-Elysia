-- Insert media asset
-- INSERT INTO media_assets (bot_id, kind, source_url, file_id, file_unique_id, width, height, duration)
-- VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
-- $1: bot_id, $2: kind, $3: source_url, $4: file_id, $5: file_unique_id, $6: width, $7: height, $8: duration

-- Get media assets for bot
-- SELECT * FROM media_assets WHERE bot_id = $1 ORDER BY created_at ASC
-- $1: bot_id

-- Update file_id for media asset
-- UPDATE media_assets SET file_id = $2, file_unique_id = $3 WHERE id = $1
-- $1: media_id, $2: file_id, $3: file_unique_id

-- Delete all media for bot
-- DELETE FROM media_assets WHERE bot_id = $1
-- $1: bot_id

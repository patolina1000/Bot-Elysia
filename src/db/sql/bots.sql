-- Get bot by slug with decrypted token
-- SELECT * FROM get_bot_by_slug($1, $2)
-- $1: slug, $2: encryption_key

-- Insert bot with encrypted token
-- INSERT INTO bots (slug, name, token_encrypted, webhook_secret) 
-- VALUES ($1, $2, pgp_sym_encrypt($3::text, $4), $5) RETURNING id, slug, name, webhook_secret, enabled, created_at
-- $1: slug, $2: name, $3: token, $4: encryption_key, $5: webhook_secret

-- Get bot with decrypted token
-- SELECT id, slug, name, pgp_sym_decrypt(token_encrypted, $2)::text as token, webhook_secret, enabled, created_at 
-- FROM bots WHERE slug = $1
-- $1: slug, $2: encryption_key

-- Get bot by id with decrypted token
-- SELECT id, slug, name, pgp_sym_decrypt(token_encrypted, $2)::text as token, webhook_secret, enabled, created_at 
-- FROM bots WHERE id = $1
-- $1: bot_id, $2: encryption_key

-- List all bots (without token)
-- SELECT id, slug, name, webhook_secret, enabled, created_at FROM bots ORDER BY created_at DESC

-- Update bot enabled status
-- UPDATE bots SET enabled = $2 WHERE id = $1
-- $1: bot_id, $2: enabled

-- Delete bot
-- DELETE FROM bots WHERE id = $1
-- $1: bot_id

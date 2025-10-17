-- Backfill telegram_contacts with existing data from funnel_events
-- This will populate the table with all distinct telegram_id per bot_slug

INSERT INTO telegram_contacts (
  bot_slug,
  telegram_id,
  chat_state,
  first_seen_at,
  last_interaction_at,
  updated_at
)
SELECT 
  b.slug AS bot_slug,
  fe.tg_user_id AS telegram_id,
  'unknown'::chat_state_enum AS chat_state,
  MIN(COALESCE(fe.occurred_at, fe.created_at)) AS first_seen_at,
  MAX(COALESCE(fe.occurred_at, fe.created_at)) AS last_interaction_at,
  now() AS updated_at
FROM funnel_events fe
INNER JOIN bots b ON b.id = fe.bot_id
WHERE fe.tg_user_id IS NOT NULL
GROUP BY b.slug, fe.tg_user_id
ON CONFLICT (bot_slug, telegram_id) 
DO UPDATE SET
  last_interaction_at = GREATEST(
    telegram_contacts.last_interaction_at, 
    EXCLUDED.last_interaction_at
  ),
  first_seen_at = LEAST(
    telegram_contacts.first_seen_at,
    EXCLUDED.first_seen_at
  ),
  updated_at = now();

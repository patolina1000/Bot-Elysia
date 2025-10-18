-- Create enum type for chat states
DO $$ BEGIN
  CREATE TYPE chat_state_enum AS ENUM ('active', 'blocked', 'deactivated', 'unknown');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; $$;

-- Create telegram_contacts table
CREATE TABLE IF NOT EXISTS telegram_contacts (
  bot_slug TEXT NOT NULL,
  telegram_id BIGINT NOT NULL,
  chat_state chat_state_enum NOT NULL DEFAULT 'unknown',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_interaction_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  unblocked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  username TEXT,
  language_code TEXT,
  is_premium BOOLEAN,
  PRIMARY KEY (bot_slug, telegram_id)
);

-- Create indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_contacts_slug_state 
  ON telegram_contacts (bot_slug, chat_state);

CREATE INDEX IF NOT EXISTS idx_contacts_slug_last_interaction 
  ON telegram_contacts (bot_slug, last_interaction_at DESC NULLS LAST);

-- Create trigger to automatically update updated_at
CREATE OR REPLACE FUNCTION update_telegram_contacts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS telegram_contacts_updated_at_trigger ON telegram_contacts;
CREATE TRIGGER telegram_contacts_updated_at_trigger
  BEFORE UPDATE ON telegram_contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_telegram_contacts_updated_at();

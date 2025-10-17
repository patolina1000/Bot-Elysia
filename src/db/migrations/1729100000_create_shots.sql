-- Migration: Create tables for shots feature
BEGIN;

-- Main shots table (definitions)
CREATE TABLE IF NOT EXISTS bot_shots (
  id               BIGSERIAL PRIMARY KEY,
  bot_slug         TEXT        NOT NULL,
  audience         TEXT        NOT NULL CHECK (audience IN ('started','pix')),
  send_mode        TEXT        NOT NULL CHECK (send_mode IN ('now','scheduled')),
  scheduled_at     TIMESTAMPTZ NULL,
  timezone         TEXT        NOT NULL DEFAULT 'America/Sao_Paulo',
  button_text      TEXT        NOT NULL,
  price_cents      INTEGER     NULL,
  extra_plans      JSONB       NULL DEFAULT '[]'::jsonb,
  intro_text       TEXT        NULL,
  copy             TEXT        NULL,
  media_url        TEXT        NULL,
  media_type       TEXT        NULL,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  status           TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','scheduled','sent','canceled','error')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_bot_shots_bot_slug ON bot_shots(bot_slug);
CREATE INDEX IF NOT EXISTS ix_bot_shots_status   ON bot_shots(status);

-- Queue table (one job per user)
CREATE TABLE IF NOT EXISTS shots_queue (
  id               BIGSERIAL PRIMARY KEY,
  bot_slug         TEXT        NOT NULL,
  shot_id          BIGINT      NOT NULL REFERENCES bot_shots(id) ON DELETE CASCADE,
  telegram_id      BIGINT      NOT NULL,
  deliver_at       TIMESTAMPTZ NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','skipped','error')),
  skip_reason      TEXT        NULL,
  attempt_count    INTEGER     NOT NULL DEFAULT 0,
  last_error       TEXT        NULL,
  sent_message_id  TEXT        NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedupe by user/shot
CREATE UNIQUE INDEX IF NOT EXISTS ux_shots_queue_unique
  ON shots_queue(shot_id, telegram_id);

CREATE INDEX IF NOT EXISTS ix_shots_queue_due
  ON shots_queue(deliver_at, status);

-- History table (sent shots)
CREATE TABLE IF NOT EXISTS shots_sent (
  id               BIGSERIAL PRIMARY KEY,
  bot_slug         TEXT        NOT NULL,
  shot_id          BIGINT      NOT NULL REFERENCES bot_shots(id) ON DELETE CASCADE,
  telegram_id      BIGINT      NOT NULL,
  message_id       TEXT        NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price_cents      INTEGER     NULL,
  meta             JSONB       NULL
);

CREATE INDEX IF NOT EXISTS ix_shots_sent_bot_shot_user
  ON shots_sent(bot_slug, shot_id, telegram_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_shots_sent_unique
  ON shots_sent(bot_slug, shot_id, telegram_id);

COMMIT;

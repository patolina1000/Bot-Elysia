CREATE TABLE IF NOT EXISTS downsell_options (
  id            BIGSERIAL PRIMARY KEY,
  downsell_id   BIGINT NOT NULL REFERENCES bot_downsells(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  price_cents   INTEGER NOT NULL CHECK (price_cents > 0),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  media_url     TEXT NULL,
  media_type    TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_downsell_options_did ON downsell_options (downsell_id);
CREATE INDEX IF NOT EXISTS ix_downsell_options_active ON downsell_options (downsell_id, active, sort_order);

-- CREATE UNIQUE INDEX IF NOT EXISTS ux_downsell_options_label ON downsell_options(downsell_id, label);

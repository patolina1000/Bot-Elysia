-- Downsells por bot
CREATE TABLE IF NOT EXISTS downsells (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('after_start','after_pix')),
  delay_minutes INT NOT NULL CHECK (delay_minutes BETWEEN 5 AND 60),
  title TEXT NOT NULL,
  price_cents INT NOT NULL CHECK (price_cents >= 50),
  message_text TEXT NULL,
  media1_url TEXT NULL,
  media1_type TEXT NULL CHECK (media1_type IN ('photo','video','audio') OR media1_type IS NULL),
  media2_url TEXT NULL,
  media2_type TEXT NULL CHECK (media2_type IN ('photo','video','audio') OR media2_type IS NULL),
  -- janela de horário
  window_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  window_start_hour SMALLINT NULL CHECK (window_start_hour BETWEEN 0 AND 23),
  window_end_hour SMALLINT NULL CHECK (window_end_hour BETWEEN 0 AND 23),
  window_tz TEXT NULL, -- ex.: 'America/Recife'
  -- limite diário por usuário (0 = sem limite)
  daily_cap_per_user INT NOT NULL DEFAULT 0,
  -- A/B (habilita uso de tabela de variantes)
  ab_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_downsells_bot ON downsells (bot_slug);
CREATE INDEX IF NOT EXISTS idx_downsells_active ON downsells (is_active);

-- Variações A/B (opcionais)
CREATE TABLE IF NOT EXISTS downsells_variants (
  id BIGSERIAL PRIMARY KEY,
  downsell_id BIGINT NOT NULL REFERENCES downsells(id) ON DELETE CASCADE,
  key CHAR(1) NOT NULL CHECK (key IN ('A','B')),
  weight SMALLINT NOT NULL DEFAULT 50 CHECK (weight BETWEEN 0 AND 100),
  title TEXT NULL,
  price_cents INT NULL,
  message_text TEXT NULL,
  media1_url TEXT NULL,
  media1_type TEXT NULL CHECK (media1_type IN ('photo','video','audio') OR media1_type IS NULL),
  media2_url TEXT NULL,
  media2_type TEXT NULL CHECK (media2_type IN ('photo','video','audio') OR media2_type IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_dsvar UNIQUE (downsell_id, key)
);

-- Fila de envios (agendamentos por usuário)
CREATE TABLE IF NOT EXISTS downsells_queue (
  id BIGSERIAL PRIMARY KEY,
  downsell_id BIGINT NOT NULL REFERENCES downsells(id) ON DELETE CASCADE,
  bot_slug TEXT NOT NULL,
  telegram_id BIGINT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sent','skipped','canceled','error')),
  error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_downsell_user UNIQUE (downsell_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_downsells_queue_bot ON downsells_queue (bot_slug);
CREATE INDEX IF NOT EXISTS idx_downsells_queue_sched ON downsells_queue (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_downsells_queue_user ON downsells_queue (telegram_id);

-- Atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_downsells_touch'
  ) THEN
    CREATE TRIGGER trg_downsells_touch
    BEFORE UPDATE ON downsells
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_downsells_queue_touch'
  ) THEN
    CREATE TRIGGER trg_downsells_queue_touch
    BEFORE UPDATE ON downsells_queue
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;

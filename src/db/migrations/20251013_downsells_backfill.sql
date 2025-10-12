-- 20251013_downsells_backfill.sql
-- Backfill de schema para downsells: adiciona colunas faltantes, cria métricas e garante fila.
-- Seguro para rodar várias vezes (IF NOT EXISTS / CHECKs compatíveis).

-- =========================
-- 1) Garantir colunas em "downsells"
-- =========================
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS message_text        TEXT;
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS media1_url          TEXT;
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS media1_type         TEXT CHECK (media1_type IN ('photo','video','audio') OR media1_type IS NULL);
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS media2_url          TEXT;
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS media2_type         TEXT CHECK (media2_type IN ('photo','video','audio') OR media2_type IS NULL);
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS window_enabled      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS window_start_hour   INT CHECK (window_start_hour BETWEEN 0 AND 23);
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS window_end_hour     INT CHECK (window_end_hour BETWEEN 0 AND 23);
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS window_tz           TEXT;
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS daily_cap_per_user  INT NOT NULL DEFAULT 0;
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS ab_enabled          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS is_active           BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS created_at          TIMESTAMP NOT NULL DEFAULT now();
ALTER TABLE downsells ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMP NOT NULL DEFAULT now();

-- =========================
-- 2) Garantir fila "downsells_queue"
--    (alguns ambientes antigos podem não ter sido criados)
-- =========================
CREATE TABLE IF NOT EXISTS downsells_queue (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  downsell_id BIGINT NOT NULL REFERENCES downsells(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('after_start','after_pix')),
  scheduled_at TIMESTAMP NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sent','skipped','canceled','error')),
  error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (downsell_id, telegram_id)
);

-- =========================
-- 3) Criar métricas "downsell_metrics"
-- =========================
CREATE TABLE IF NOT EXISTS downsell_metrics (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  downsell_id BIGINT NOT NULL REFERENCES downsells(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN ('view','click','purchase','pix_created')),
  telegram_id BIGINT NULL,
  meta JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dm_bot_slug            ON downsell_metrics(bot_slug);
CREATE INDEX IF NOT EXISTS idx_dm_downsell_id         ON downsell_metrics(downsell_id);
CREATE INDEX IF NOT EXISTS idx_dm_event               ON downsell_metrics(event);
CREATE INDEX IF NOT EXISTS idx_dm_created_at          ON downsell_metrics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_bot_downsell_event  ON downsell_metrics(bot_slug, downsell_id, event, created_at DESC);


-- Tabela de métricas para tracking de eventos de downsells
CREATE TABLE IF NOT EXISTS downsell_metrics (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  downsell_id BIGINT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('view', 'click', 'purchase', 'pix_created')),
  telegram_id BIGINT NULL,  -- opcional, para rastrear por usuário
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_dm_bot_slug ON downsell_metrics(bot_slug);
CREATE INDEX IF NOT EXISTS idx_dm_downsell_id ON downsell_metrics(downsell_id);
CREATE INDEX IF NOT EXISTS idx_dm_event ON downsell_metrics(event);
CREATE INDEX IF NOT EXISTS idx_dm_created_at ON downsell_metrics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_telegram_id ON downsell_metrics(telegram_id) WHERE telegram_id IS NOT NULL;

-- Índice composto para queries de métricas por bot/downsell
CREATE INDEX IF NOT EXISTS idx_dm_bot_downsell_event 
  ON downsell_metrics(bot_slug, downsell_id, event, created_at DESC);

-- Comentários
COMMENT ON TABLE downsell_metrics IS 'Tracking de eventos de downsells (views, clicks, purchases)';
COMMENT ON COLUMN downsell_metrics.event IS 'Tipo de evento: view, click, purchase, pix_created';
COMMENT ON COLUMN downsell_metrics.meta IS 'Dados adicionais do evento (JSON)';

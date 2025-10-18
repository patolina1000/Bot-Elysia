-- Garante cache de mídias por bot
CREATE TABLE IF NOT EXISTS public.bot_media_cache (
  id             BIGSERIAL PRIMARY KEY,
  bot_slug       TEXT NOT NULL,
  media_key      TEXT NOT NULL,
  media_type     TEXT NOT NULL,
  source_url     TEXT,
  file_id        TEXT,
  file_unique_id TEXT,
  width          INT,
  height         INT,
  duration       INT,
  status         TEXT NOT NULL DEFAULT 'warm',
  last_warmed_at TIMESTAMPTZ DEFAULT now(),
  retries        INT NOT NULL DEFAULT 0,
  meta           JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_bot_media_cache_slug
  ON public.bot_media_cache (bot_slug);

CREATE INDEX IF NOT EXISTS ix_bot_media_cache_status
  ON public.bot_media_cache (status);

-- Ajustes auxiliares (se usados pelo seu código)
CREATE TABLE IF NOT EXISTS public.tg_bot_settings (
  bot_slug        TEXT PRIMARY KEY,
  warmup_chat_id  TEXT
);

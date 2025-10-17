-- shots (campanhas de disparo)
CREATE TABLE IF NOT EXISTS public.shots (
  id              BIGSERIAL PRIMARY KEY,
  bot_slug        TEXT NOT NULL,
  audience        TEXT NOT NULL CHECK (audience IN ('started','pix')),
  media_type      TEXT NOT NULL CHECK (media_type IN ('text','photo','video','audio','animation')),
  message_text    TEXT,
  media_url       TEXT,
  parse_mode      TEXT DEFAULT 'HTML',
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('draft','scheduled','paused','canceled','finished')),
  deliver_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- fila expandida por destinatário (um registro por usuário)
CREATE TABLE IF NOT EXISTS public.shots_queue (
  id              BIGSERIAL PRIMARY KEY,
  shot_id         BIGINT NOT NULL REFERENCES public.shots(id) ON DELETE CASCADE,
  bot_slug        TEXT NOT NULL,
  telegram_id     BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sent','error','skipped','canceled')),
  deliver_at      TIMESTAMPTZ NOT NULL,
  attempt_count   SMALLINT NOT NULL DEFAULT 0,
  last_error      TEXT,
  sent_message_id BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shot_id, telegram_id)
);

-- histórico enxuto (opcional, mas útil)
CREATE TABLE IF NOT EXISTS public.shots_sent (
  id              BIGSERIAL PRIMARY KEY,
  shot_id         BIGINT NOT NULL REFERENCES public.shots(id) ON DELETE CASCADE,
  bot_slug        TEXT NOT NULL,
  telegram_id     BIGINT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_id      BIGINT,
  status          TEXT NOT NULL CHECK (status IN ('sent','error','skipped')),
  error           TEXT
);

-- índices para performance do worker
CREATE INDEX IF NOT EXISTS ix_shots_queue_scheduled ON public.shots_queue (deliver_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS ix_shots_queue_status_deliver ON public.shots_queue (status, deliver_at);

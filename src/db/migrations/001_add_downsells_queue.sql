CREATE TABLE IF NOT EXISTS public.downsells_queue (
  id                BIGSERIAL PRIMARY KEY,
  bot_slug          TEXT NOT NULL,
  downsell_id       BIGINT NOT NULL,
  telegram_id       BIGINT NOT NULL,
  deliver_at        TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|sent|skipped|error
  attempt_count     INT NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_downsells_queue_unique
  ON public.downsells_queue (bot_slug, downsell_id, telegram_id);

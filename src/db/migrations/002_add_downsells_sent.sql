CREATE TABLE IF NOT EXISTS public.downsells_sent (
  id                BIGSERIAL PRIMARY KEY,
  bot_slug          TEXT NOT NULL,
  downsell_id       BIGINT NOT NULL,
  telegram_id       BIGINT NOT NULL,
  transaction_id    TEXT,
  external_id       TEXT,
  sent_message_id   TEXT,
  status            TEXT NOT NULL DEFAULT 'sent', -- sent|paid|canceled
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_downsells_sent_unique
  ON public.downsells_sent (bot_slug, downsell_id, telegram_id);

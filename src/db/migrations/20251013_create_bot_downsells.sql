-- Criação inicial da tabela de downsells por bot
CREATE TABLE IF NOT EXISTS public.bot_downsells (
  id            BIGSERIAL PRIMARY KEY,
  bot_slug      TEXT NOT NULL,
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
  copy          TEXT NOT NULL,
  media_url     TEXT,
  media_type    TEXT,
  trigger       TEXT NOT NULL CHECK (trigger IN ('after_start','after_pix')),
  delay_minutes INTEGER NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0 AND delay_minutes <= 10080),
  sort_order    INTEGER DEFAULT 0,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice para consultas por bot e ordenação
CREATE INDEX IF NOT EXISTS ix_bot_downsells_bot_slug_sort
  ON public.bot_downsells (bot_slug, sort_order);

-- (não criamos trigger de updated_at aqui; colunas extras virão nas migrations de 20251016 e 20251018)

-- Garante estrutura mínima de shots e shot_plans, FKs e índices (idempotente)

-- shots: cria se não existir
CREATE TABLE IF NOT EXISTS public.shots (
  id          BIGSERIAL PRIMARY KEY,
  bot_slug    TEXT NOT NULL,
  title       TEXT,
  copy        TEXT,
  media_url   TEXT,
  media_type  TEXT,
  target      TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- shots: adiciona colunas que possam faltar (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shots' AND column_name='title') THEN
    EXECUTE 'ALTER TABLE public.shots ADD COLUMN title TEXT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shots' AND column_name='copy') THEN
    EXECUTE 'ALTER TABLE public.shots ADD COLUMN copy TEXT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shots' AND column_name='media_url') THEN
    EXECUTE 'ALTER TABLE public.shots ADD COLUMN media_url TEXT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shots' AND column_name='media_type') THEN
    EXECUTE 'ALTER TABLE public.shots ADD COLUMN media_type TEXT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shots' AND column_name='target') THEN
    EXECUTE 'ALTER TABLE public.shots ADD COLUMN target TEXT NOT NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shots' AND column_name='scheduled_at') THEN
    EXECUTE 'ALTER TABLE public.shots ADD COLUMN scheduled_at TIMESTAMPTZ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shots' AND column_name='created_at') THEN
    EXECUTE 'ALTER TABLE public.shots ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now()';
  END IF;
END $$;

-- shot_plans: cria se não existir
CREATE TABLE IF NOT EXISTS public.shot_plans (
  id          BIGSERIAL PRIMARY KEY,
  shot_id     BIGINT NOT NULL,
  plan_name   TEXT NOT NULL,
  price_cents INT CHECK (price_cents >= 50),
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- shot_plans: adiciona colunas que possam faltar
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shot_plans' AND column_name='sort_order') THEN
    EXECUTE 'ALTER TABLE public.shot_plans ADD COLUMN sort_order INT NOT NULL DEFAULT 0';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shot_plans' AND column_name='is_active') THEN
    EXECUTE 'ALTER TABLE public.shot_plans ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shot_plans' AND column_name='created_at') THEN
    EXECUTE 'ALTER TABLE public.shot_plans ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='shot_plans' AND column_name='updated_at') THEN
    EXECUTE 'ALTER TABLE public.shot_plans ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now()';
  END IF;
END $$;

-- FK shot_plans(shot_id) -> shots(id) com ON DELETE CASCADE (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'shot_plans' AND c.conname = 'shot_plans_shot_id_fkey'
  ) THEN
    EXECUTE '
      ALTER TABLE public.shot_plans
        ADD CONSTRAINT shot_plans_shot_id_fkey
        FOREIGN KEY (shot_id)
        REFERENCES public.shots(id)
        ON DELETE CASCADE
    ';
  END IF;
END $$;

-- Índice de ordenação estável (idempotente)
CREATE INDEX IF NOT EXISTS shot_plans_shot_id_sort_idx
  ON public.shot_plans (shot_id, sort_order);

-- Log informativo
DO $$
BEGIN
  RAISE NOTICE '[MIG][SHOTS_CORE_FIX] Estrutura de shots/shot_plans garantida.';
END $$;

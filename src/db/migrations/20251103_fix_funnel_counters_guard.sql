DO $$
BEGIN
  -- cria tabela se não existir
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='funnel_counters'
  ) THEN
    CREATE TABLE public.funnel_counters (
      day date NOT NULL,
      bot_slug text NOT NULL,
      metric text NOT NULL,
      value bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (day, bot_slug, metric)
    );
  END IF;

  -- tipos/colunas
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='funnel_counters'
               AND column_name='day' AND data_type <> 'date') THEN
    ALTER TABLE public.funnel_counters
      ALTER COLUMN day TYPE date USING day::date;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='funnel_counters'
                   AND column_name='updated_at') THEN
    ALTER TABLE public.funnel_counters
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  END IF;

  -- índice auxiliar
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='funnel_counters'
      AND indexname='ix_funnel_counters_updated_at'
  ) THEN
    CREATE INDEX ix_funnel_counters_updated_at
      ON public.funnel_counters (updated_at);
  END IF;
END
$$;

DO $$
DECLARE
  tname text;
BEGIN
  -- detecta qual tabela existe: legado (bot_settings) ou atual (tg_bot_settings)
  IF to_regclass('public.bot_settings') IS NOT NULL THEN
    tname := 'bot_settings';
  ELSIF to_regclass('public.tg_bot_settings') IS NOT NULL THEN
    tname := 'tg_bot_settings';
  ELSE
    RAISE NOTICE 'Nenhuma tabela de settings encontrada (bot_settings/tg_bot_settings). Migration ignorada.';
    RETURN;
  END IF;

  -- adiciona a coluna se não existir
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = tname
      AND column_name  = 'offers_text'
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN offers_text TEXT', tname);
  ELSE
    -- garante tipo TEXT caso a coluna exista com outro tipo
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN offers_text TYPE TEXT', tname);
  END IF;
END
$$;

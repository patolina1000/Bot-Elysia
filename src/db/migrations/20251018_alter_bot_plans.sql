-- 20251018_alter_bot_plans.sql
-- Migração incremental para ajustar bot_plans sem quebrar ambientes já aplicados.
-- Regras: somente ALTERs/CREATEs condicionais; nada de DROP/RENAME sem checagem.

DO $$
BEGIN
  -- Garantir que a função trg_set_updated_at exista no schema public
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'trg_set_updated_at'
       AND n.nspname = 'public'
  ) THEN
    EXECUTE $$
      CREATE FUNCTION public.trg_set_updated_at()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $BODY$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $BODY$;
    $$;
  ELSE
    EXECUTE $$
      CREATE OR REPLACE FUNCTION public.trg_set_updated_at()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $BODY$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $BODY$;
    $$;
  END IF;
END
$$;

DO $$
BEGIN
  -- Certificar que o trigger set_updated_at_on_bot_plans usa a função correta
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgname = 'set_updated_at_on_bot_plans'
       AND n.nspname = 'public'
       AND c.relname = 'bot_plans'
       AND p.proname = 'trg_set_updated_at'
  ) THEN
    IF EXISTS (
      SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE t.tgname = 'set_updated_at_on_bot_plans'
         AND n.nspname = 'public'
         AND c.relname = 'bot_plans'
    ) THEN
      EXECUTE 'DROP TRIGGER set_updated_at_on_bot_plans ON public.bot_plans';
    END IF;

    EXECUTE 'CREATE TRIGGER set_updated_at_on_bot_plans '
         || 'BEFORE UPDATE ON public.bot_plans '
         || 'FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at()';
  END IF;
END
$$;

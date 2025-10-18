-- 20251018_alter_bot_plans.sql
-- Ajustes em bot_plans: função updated_at garantida + trigger idempotente

-- a) Garante/atualiza a função global de updated_at (sem EXECUTE)
CREATE OR REPLACE FUNCTION public.trg_set_updated_at()
RETURNS trigger
AS $BODY$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$BODY$
LANGUAGE plpgsql;

-- b) Garante o trigger no bot_plans (drop & create idempotente)
DO $$
BEGIN
  -- sempre recria de forma segura
  EXECUTE 'DROP TRIGGER IF EXISTS set_updated_at_on_bot_plans ON public.bot_plans';
  EXECUTE 'CREATE TRIGGER set_updated_at_on_bot_plans '
       || 'BEFORE UPDATE ON public.bot_plans '
       || 'FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at()';
END $$;

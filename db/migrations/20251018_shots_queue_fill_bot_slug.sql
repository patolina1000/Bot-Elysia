-- Preenche retroativamente quaisquer registros sem bot_slug
UPDATE public.shots_queue q
SET bot_slug = s.bot_slug
FROM public.shots s
WHERE q.shot_id = s.id
  AND q.bot_slug IS NULL;

-- Função para garantir bot_slug durante INSERTs
CREATE OR REPLACE FUNCTION public.shots_queue_fill_bot_slug()
RETURNS trigger AS $$
BEGIN
  IF NEW.bot_slug IS NULL THEN
    SELECT s.bot_slug INTO NEW.bot_slug
    FROM public.shots s
    WHERE s.id = NEW.shot_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger que aplica a função antes de inserir
DROP TRIGGER IF EXISTS tr_shots_queue_fill_bot_slug ON public.shots_queue;
CREATE TRIGGER tr_shots_queue_fill_bot_slug
BEFORE INSERT ON public.shots_queue
FOR EACH ROW
EXECUTE FUNCTION public.shots_queue_fill_bot_slug();

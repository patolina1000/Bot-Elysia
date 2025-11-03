-- Adiciona suporte a múltiplas mensagens iniciais no /start
-- Mantém retrocompatibilidade com o campo 'text' existente

ALTER TABLE IF EXISTS public.templates_start
ADD COLUMN IF NOT EXISTS start_messages JSONB DEFAULT '[]'::jsonb;

-- Migra dados existentes: se 'text' não está vazio, adiciona ao array start_messages
UPDATE public.templates_start
SET start_messages = jsonb_build_array(text)
WHERE text IS NOT NULL
  AND text <> ''
  AND (start_messages IS NULL OR start_messages = '[]'::jsonb);

-- Índice para melhorar performance de queries
CREATE INDEX IF NOT EXISTS idx_templates_start_messages ON public.templates_start USING gin(start_messages);

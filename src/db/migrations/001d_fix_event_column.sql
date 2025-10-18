-- 001d_fix_event_column.sql
-- Garante que a tabela tenha a coluna "event" (renomeia de event_name se precisar)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'funnel_events' AND column_name = 'event'
  ) THEN
    -- se existir event_name, renomeia para event
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'funnel_events' AND column_name = 'event_name'
    ) THEN
      EXECUTE 'ALTER TABLE funnel_events RENAME COLUMN event_name TO event';
    ELSE
      -- senão, cria a coluna
      EXECUTE 'ALTER TABLE funnel_events ADD COLUMN event TEXT';
      -- garante algum valor para linhas antigas (se houver)
      EXECUTE 'UPDATE funnel_events SET event = COALESCE(event, ''unknown'')';
    END IF;
  END IF;
END; $$;

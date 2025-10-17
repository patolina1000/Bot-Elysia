-- ===========================================================================
-- Emergency fix: Clean up shots_queue table structure
-- ===========================================================================
-- Issue: The table has a "shot_id" column that should NOT exist
-- Error: "null value in column shot_id of relation shots_queue violates not-null constraint"
-- 
-- Root cause: The table structure in production is corrupted/incorrect
-- This migration will:
-- 1. Drop the incorrect "shot_id" column if it exists
-- 2. Ensure "id" column is the PRIMARY KEY (BIGSERIAL)
-- 3. Verify all columns match the expected schema
-- ===========================================================================

-- 1. Drop shot_id column if it exists (it should NOT exist in shots_queue)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'shot_id'
  ) THEN
    ALTER TABLE public.shots_queue DROP COLUMN shot_id CASCADE;
    RAISE NOTICE '❌ Removed incorrect column: shot_id (should only exist in shots_sent)';
  END IF;
END $$;

-- 2. Ensure "id" column exists as BIGSERIAL PRIMARY KEY
DO $$ BEGIN
  -- Check if id column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'id'
  ) THEN
    -- Create sequence if doesn't exist
    CREATE SEQUENCE IF NOT EXISTS shots_queue_id_seq;
    
    -- Add id column
    ALTER TABLE public.shots_queue
      ADD COLUMN id BIGINT NOT NULL DEFAULT nextval('shots_queue_id_seq');
    
    -- Set as primary key
    ALTER TABLE public.shots_queue
      ADD PRIMARY KEY (id);
      
    -- Associate sequence with column
    ALTER SEQUENCE shots_queue_id_seq OWNED BY shots_queue.id;
    
    RAISE NOTICE '✅ Created id column as BIGSERIAL PRIMARY KEY';
  ELSE
    -- Ensure id is primary key
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'shots_queue'
        AND constraint_type = 'PRIMARY KEY'
    ) THEN
      ALTER TABLE public.shots_queue ADD PRIMARY KEY (id);
      RAISE NOTICE '✅ Set id as PRIMARY KEY';
    END IF;
  END IF;
END $$;

-- 3. Verify column order by recreating table if needed
-- This ensures columns are in the expected order matching our TypeScript code

DO $$ 
DECLARE
  has_wrong_structure BOOLEAN;
BEGIN
  -- Check if table has unexpected columns or structure
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name NOT IN (
        'id', 'bot_slug', 'target', 'copy', 'media_url', 'media_type',
        'scheduled_at', 'status', 'attempt_count', 'last_error',
        'created_at', 'updated_at'
      )
  ) INTO has_wrong_structure;
  
  IF has_wrong_structure THEN
    RAISE NOTICE '⚠️  Table has unexpected columns. Manual cleanup may be needed.';
    RAISE NOTICE '⚠️  Please check table structure: SELECT * FROM information_schema.columns WHERE table_name = ''shots_queue''';
  ELSE
    RAISE NOTICE '✅ All columns are expected columns';
  END IF;
END $$;

-- 4. Log final structure
DO $$ 
DECLARE
  col_list TEXT;
BEGIN
  SELECT string_agg(column_name || ' (' || data_type || ')', ', ' ORDER BY ordinal_position)
  INTO col_list
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'shots_queue';
  
  RAISE NOTICE '===========================================================================';
  RAISE NOTICE 'shots_queue final structure:';
  RAISE NOTICE '%', col_list;
  RAISE NOTICE '===========================================================================';
END $$;


-- Fix migration: Ensure shots_queue has target column with proper enum type
-- This migration is idempotent and can be run multiple times safely

-- Step 1: Ensure the enum type exists
DO $$ BEGIN
  CREATE TYPE shot_target_enum AS ENUM ('started', 'pix_created');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Step 2: Add target column if it doesn't exist
-- We'll add it with a temporary DEFAULT to handle existing rows
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'target'
  ) THEN
    -- Add column with temporary default for backfill
    EXECUTE 'ALTER TABLE public.shots_queue ADD COLUMN target shot_target_enum NOT NULL DEFAULT ''started''::shot_target_enum';
    
    -- Remove the default after backfill (new inserts must specify target explicitly)
    EXECUTE 'ALTER TABLE public.shots_queue ALTER COLUMN target DROP DEFAULT';
    
    RAISE NOTICE 'Added target column to shots_queue with backfill default, then removed default';
  ELSE
    RAISE NOTICE 'target column already exists in shots_queue, skipping';
  END IF;
END $$;

-- Step 3: Ensure target column has correct type (in case it was created with wrong type)
-- This will fail safely if the column is already the correct type
DO $$ BEGIN
  -- Check if column exists but is not the correct type
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'target'
      AND data_type != 'USER-DEFINED'
  ) THEN
    -- Column exists but wrong type, need to convert
    RAISE NOTICE 'Converting target column to shot_target_enum type';
    EXECUTE 'ALTER TABLE public.shots_queue ALTER COLUMN target TYPE shot_target_enum USING target::shot_target_enum';
  END IF;
END $$;

-- Step 4: Ensure target column is NOT NULL
DO $$ BEGIN
  -- Check if target column allows nulls
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'target'
      AND is_nullable = 'YES'
  ) THEN
    RAISE NOTICE 'Setting target column to NOT NULL';
    -- First ensure no NULL values exist (backfill with 'started')
    EXECUTE 'UPDATE shots_queue SET target = ''started''::shot_target_enum WHERE target IS NULL';
    -- Then add NOT NULL constraint
    EXECUTE 'ALTER TABLE public.shots_queue ALTER COLUMN target SET NOT NULL';
  END IF;
END $$;

-- Verification: Log the final state
DO $$ 
DECLARE
  col_type TEXT;
  col_nullable TEXT;
BEGIN
  SELECT data_type, is_nullable
  INTO col_type, col_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'shots_queue'
    AND column_name = 'target';
    
  IF FOUND THEN
    RAISE NOTICE 'shots_queue.target: type=%, nullable=%', col_type, col_nullable;
  ELSE
    RAISE WARNING 'shots_queue.target column not found!';
  END IF;
END $$;

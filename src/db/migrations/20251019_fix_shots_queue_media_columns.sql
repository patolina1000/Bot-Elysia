-- ===========================================================================
-- Comprehensive fix for shots_queue table
-- ===========================================================================
-- This migration ensures all columns exist with correct types and constraints.
-- It fixes issues caused by inconsistent migration execution in production.
--
-- Background: The error "column media_url does not exist" indicates that
-- the table was created without all expected columns, likely due to:
-- 1. Incomplete migration execution
-- 2. Table created before 20251017_create_shots_queue.sql ran
-- 3. Conflicting migration statements
-- ===========================================================================

-- Ensure enums exist
DO $$ BEGIN
  CREATE TYPE shot_target_enum AS ENUM ('started', 'pix_created');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE shot_status_enum AS ENUM ('pending', 'running', 'sent', 'skipped', 'error');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Ensure all required columns exist
-- (These should have been created by 20251017_create_shots_queue.sql but may be missing)

-- 1. media_url column
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'media_url'
  ) THEN
    ALTER TABLE public.shots_queue
      ADD COLUMN media_url TEXT;
    RAISE NOTICE 'Added missing column: media_url';
  END IF;
END $$;

-- 2. media_type column
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'media_type'
  ) THEN
    ALTER TABLE public.shots_queue
      ADD COLUMN media_type TEXT;
    
    -- Set default value for existing rows
    UPDATE public.shots_queue
      SET media_type = 'none'
      WHERE media_type IS NULL;
      
    RAISE NOTICE 'Added missing column: media_type';
  END IF;
END $$;

-- 3. Ensure media_type has the correct constraint
DO $$ BEGIN
  -- Drop existing constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shots_queue_media_type_check'
      AND conrelid = 'public.shots_queue'::regclass
  ) THEN
    ALTER TABLE public.shots_queue
      DROP CONSTRAINT shots_queue_media_type_check;
  END IF;
  
  -- Add the constraint
  ALTER TABLE public.shots_queue
    ADD CONSTRAINT shots_queue_media_type_check
    CHECK (media_type IN ('photo', 'video', 'audio', 'none'));
    
  RAISE NOTICE 'Applied media_type constraint';
END $$;

-- 4. Ensure bot_slug exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'bot_slug'
  ) THEN
    ALTER TABLE public.shots_queue
      ADD COLUMN bot_slug TEXT NOT NULL DEFAULT '';
    RAISE NOTICE 'Added missing column: bot_slug';
  END IF;
END $$;

-- 5. Ensure copy exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'copy'
  ) THEN
    ALTER TABLE public.shots_queue
      ADD COLUMN copy TEXT NOT NULL DEFAULT '';
    RAISE NOTICE 'Added missing column: copy';
  END IF;
END $$;

-- 6. Ensure scheduled_at exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'scheduled_at'
  ) THEN
    ALTER TABLE public.shots_queue
      ADD COLUMN scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now();
    RAISE NOTICE 'Added missing column: scheduled_at';
  END IF;
END $$;

-- 7. Ensure created_at exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE public.shots_queue
      ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    RAISE NOTICE 'Added missing column: created_at';
  END IF;
END $$;

-- 8. Ensure updated_at exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE public.shots_queue
      ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    RAISE NOTICE 'Added missing column: updated_at';
  END IF;
END $$;

-- Summary
DO $$ BEGIN
  RAISE NOTICE '===========================================================================';
  RAISE NOTICE 'Migration 20251019_fix_shots_queue_media_columns.sql completed';
  RAISE NOTICE 'All required columns for shots_queue are now present';
  RAISE NOTICE '===========================================================================';
END $$;


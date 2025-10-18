-- ===========================================================================
-- CRITICAL FIX: Rebuild shots_queue table with correct structure
-- ===========================================================================
-- Issue: Table has corrupt structure with wrong columns (shot_id, wrong order)
-- This migration safely rebuilds the table with the correct schema
-- ===========================================================================

-- Step 1: Create backup of existing data (if any)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shots_queue') THEN
    DROP TABLE IF EXISTS shots_queue_backup_20251020 CASCADE;
    CREATE TABLE shots_queue_backup_20251020 AS SELECT * FROM shots_queue;
    RAISE NOTICE '✅ Backed up existing shots_queue data';
  END IF;
END $$;

-- Step 2: Drop foreign key constraints from shots_sent (if exists)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'shots_sent_shot_id_fkey'
      AND table_name = 'shots_sent'
  ) THEN
    ALTER TABLE shots_sent DROP CONSTRAINT shots_sent_shot_id_fkey;
    RAISE NOTICE '✅ Dropped FK constraint from shots_sent';
  END IF;
END $$;

-- Step 3: Drop and recreate shots_queue with correct structure
DROP TABLE IF EXISTS shots_queue CASCADE;

-- Ensure enums exist first
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

-- Create table with CORRECT structure
CREATE TABLE shots_queue (
  id BIGSERIAL PRIMARY KEY,
  bot_slug TEXT NOT NULL,
  target shot_target_enum NOT NULL,
  copy TEXT NOT NULL,
  media_url TEXT,
  media_type TEXT CHECK (media_type IN ('photo', 'video', 'audio', 'none')),
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status shot_status_enum NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  RAISE NOTICE '✅ Created shots_queue table with correct structure';
END $$;

-- Step 4: Create indexes
CREATE INDEX idx_shots_queue_scheduled 
  ON shots_queue (status, scheduled_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX idx_shots_queue_slug 
  ON shots_queue (bot_slug, status, scheduled_at DESC);

DO $$ BEGIN
  RAISE NOTICE '✅ Created indexes';
END $$;

-- Step 5: Create updated_at trigger
CREATE OR REPLACE FUNCTION update_shots_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shots_queue_updated_at_trigger ON shots_queue;
CREATE TRIGGER shots_queue_updated_at_trigger
  BEFORE UPDATE ON shots_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_shots_queue_updated_at();

DO $$ BEGIN
  RAISE NOTICE '✅ Created update trigger';
END $$;

-- Step 6: Restore data from backup (if compatible)
DO $$ 
DECLARE
  backup_exists BOOLEAN;
  row_count INT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'shots_queue_backup_20251020'
  ) INTO backup_exists;
  
  IF backup_exists THEN
    -- Try to restore only compatible rows
    INSERT INTO shots_queue (
      bot_slug, target, copy, media_url, media_type,
      scheduled_at, status, attempt_count, last_error,
      created_at, updated_at
    )
    SELECT 
      COALESCE(bot_slug, 'unknown'),
      COALESCE(
        CASE 
          WHEN target::TEXT IN ('started', 'pix_created') THEN target::shot_target_enum
          ELSE 'started'::shot_target_enum
        END,
        'started'::shot_target_enum
      ),
      COALESCE(copy, ''),
      media_url,
      COALESCE(media_type, 'none'),
      COALESCE(scheduled_at, now()),
      COALESCE(
        CASE 
          WHEN status::TEXT IN ('pending', 'running', 'sent', 'skipped', 'error') THEN status::shot_status_enum
          ELSE 'pending'::shot_status_enum
        END,
        'pending'::shot_status_enum
      ),
      COALESCE(attempt_count, 0),
      last_error,
      COALESCE(created_at, now()),
      COALESCE(updated_at, now())
    FROM shots_queue_backup_20251020
    WHERE bot_slug IS NOT NULL
      AND copy IS NOT NULL;
    
    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE NOTICE '✅ Restored % rows from backup', row_count;
  END IF;
END $$;

-- Step 7: Recreate foreign key from shots_sent
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shots_sent') THEN
    ALTER TABLE shots_sent 
      ADD CONSTRAINT shots_sent_shot_id_fkey 
      FOREIGN KEY (shot_id) 
      REFERENCES shots_queue(id) 
      ON DELETE CASCADE;
    RAISE NOTICE '✅ Recreated FK constraint in shots_sent';
  END IF;
END $$;

-- Step 8: Final verification
DO $$ 
DECLARE
  col_count INT;
  expected_cols TEXT[] := ARRAY[
    'id', 'bot_slug', 'target', 'copy', 'media_url', 'media_type',
    'scheduled_at', 'status', 'attempt_count', 'last_error',
    'created_at', 'updated_at'
  ];
  actual_cols TEXT[];
BEGIN
  SELECT array_agg(column_name ORDER BY ordinal_position)
  INTO actual_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'shots_queue';
  
  SELECT count(*) INTO col_count FROM unnest(actual_cols);
  
  IF col_count = 12 AND actual_cols = expected_cols THEN
    RAISE NOTICE '===========================================================================';
    RAISE NOTICE '✅✅✅ SUCCESS: shots_queue table rebuilt correctly';
    RAISE NOTICE '✅ Total columns: % (expected: 12)', col_count;
    RAISE NOTICE '✅ Column order: CORRECT';
    RAISE NOTICE '===========================================================================';
  ELSE
    RAISE WARNING '⚠️ Table rebuilt but column mismatch detected';
    RAISE WARNING 'Expected: %', expected_cols;
    RAISE WARNING 'Actual: %', actual_cols;
  END IF;
END $$;


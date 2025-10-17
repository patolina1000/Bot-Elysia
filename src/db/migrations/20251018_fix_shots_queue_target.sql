-- Ensure shot_target_enum exists with required values
DO $$ BEGIN
  CREATE TYPE shot_target_enum AS ENUM ('started', 'pix_created');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'shot_target_enum' AND e.enumlabel = 'started'
  ) THEN
    ALTER TYPE shot_target_enum ADD VALUE 'started';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'shot_target_enum' AND e.enumlabel = 'pix_created'
  ) THEN
    ALTER TYPE shot_target_enum ADD VALUE 'pix_created';
  END IF;
END $$;

-- Ensure shots_queue.target exists with the correct type and constraints
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shots_queue'
      AND column_name = 'target'
  ) THEN
    ALTER TABLE public.shots_queue
      ADD COLUMN target shot_target_enum;

    ALTER TABLE public.shots_queue
      ALTER COLUMN target SET DEFAULT 'started';

    UPDATE public.shots_queue
      SET target = 'started'
      WHERE target IS NULL;

    ALTER TABLE public.shots_queue
      ALTER COLUMN target DROP DEFAULT;
  ELSE
    -- Ensure the column uses the correct enum type
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'shots_queue'
        AND column_name = 'target'
        AND udt_name <> 'shot_target_enum'
    ) THEN
      ALTER TABLE public.shots_queue
        ALTER COLUMN target TYPE shot_target_enum
        USING target::text::shot_target_enum;
    END IF;

    -- Backfill any missing targets
    UPDATE public.shots_queue
      SET target = 'started'
      WHERE target IS NULL;
  END IF;

  -- Ensure the NOT NULL constraint is applied
  ALTER TABLE public.shots_queue
    ALTER COLUMN target SET NOT NULL;
END $$;

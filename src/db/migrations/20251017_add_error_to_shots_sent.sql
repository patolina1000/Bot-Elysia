-- shots_sent: add 'error' column used by bulkRecordShotsSent()
-- Safe to run multiple times.
ALTER TABLE IF EXISTS public.shots_sent
  ADD COLUMN IF NOT EXISTS error text;

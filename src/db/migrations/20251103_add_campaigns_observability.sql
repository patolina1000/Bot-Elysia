-- 20251103_add_campaigns_observability.sql
-- Observabilidade de campanhas + padronização de status

ALTER TABLE IF EXISTS public.campaigns
  ADD COLUMN IF NOT EXISTS started_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_targets  INTEGER,
  ADD COLUMN IF NOT EXISTS sent_count     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fail_count     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error     TEXT;

-- Índices úteis
CREATE INDEX IF NOT EXISTS ix_campaigns_status_created_at
  ON public.campaigns(status, created_at);

CREATE INDEX IF NOT EXISTS ix_campaigns_finished_at
  ON public.campaigns(finished_at);

-- Status esperados (livre, status é TEXT): 'draft' | 'active' | 'running' | 'completed' | 'failed'

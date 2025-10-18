-- Recria/garante estrutura e índices de payment_transactions de forma idempotente
CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id            BIGSERIAL PRIMARY KEY,
  gateway       TEXT NOT NULL DEFAULT 'pushinpay',
  external_id   TEXT NOT NULL,
  status        TEXT NOT NULL,
  value_cents   INT  NOT NULL CHECK (value_cents >= 50),
  qr_code       TEXT,
  qr_code_base64 TEXT,
  webhook_url   TEXT,
  end_to_end_id TEXT,
  payer_name    TEXT,
  payer_doc     TEXT,
  telegram_id   BIGINT,
  payload_id    TEXT,
  plan_name     TEXT,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- unicidade por gateway + external_id
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_transactions_gateway_external
  ON public.payment_transactions (gateway, external_id);

-- índices úteis
CREATE INDEX IF NOT EXISTS ix_payment_transactions_status
  ON public.payment_transactions (status);

CREATE INDEX IF NOT EXISTS ix_payment_transactions_created_at
  ON public.payment_transactions (created_at);

-- função global de updated_at (somente se não existir em 'public')
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'trg_set_updated_at' AND n.nspname = 'public'
  ) THEN
    CREATE OR REPLACE FUNCTION public.trg_set_updated_at()
    RETURNS trigger
    AS $body$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $body$ LANGUAGE plpgsql;
  END IF;
END $$;

-- (re)cria o trigger de forma idempotente
DROP TRIGGER IF EXISTS set_updated_at_on_payment_transactions ON public.payment_transactions;
CREATE TRIGGER set_updated_at_on_payment_transactions
BEFORE UPDATE ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();

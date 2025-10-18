-- payments: persistência única para qualquer gateway
CREATE TABLE IF NOT EXISTS payment_transactions (
  id BIGSERIAL PRIMARY KEY,
  gateway TEXT NOT NULL DEFAULT 'pushinpay',
  external_id TEXT NOT NULL,
  status TEXT NOT NULL,
  value_cents INT NOT NULL CHECK (value_cents >= 50),
  qr_code TEXT,
  qr_code_base64 TEXT,
  webhook_url TEXT,
  end_to_end_id TEXT,
  payer_name TEXT,
  payer_doc TEXT,
  telegram_id BIGINT,
  payload_id TEXT,
  plan_name TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_transactions_gateway_external
  ON payment_transactions (gateway, external_id);

CREATE INDEX IF NOT EXISTS ix_payment_transactions_status
  ON payment_transactions (status);

-- trigger simples para updated_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'trg_set_updated_at'
  ) THEN
    CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER AS $body$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $body$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at_on_payment_transactions ON payment_transactions;
CREATE TRIGGER set_updated_at_on_payment_transactions
BEFORE UPDATE ON payment_transactions
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

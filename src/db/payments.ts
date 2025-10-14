import { pool } from './pool.js';
import { logger } from '../logger.js';
import { generatePixTraceId } from '../utils/pixLogging.js';

export interface PaymentTransaction {
  id: number;
  gateway: string;
  external_id: string;
  status: string;
  value_cents: number;
  qr_code: string | null;
  qr_code_base64: string | null;
  webhook_url: string | null;
  end_to_end_id: string | null;
  payer_name: string | null;
  payer_doc: string | null;
  telegram_id: number | null;
  payload_id: string | null;
  plan_name: string | null;
  meta: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface InsertPaymentParams {
  gateway: string;
  external_id: string;
  status: string;
  value_cents: number;
  qr_code?: string | null;
  qr_code_base64?: string | null;
  webhook_url?: string | null;
  end_to_end_id?: string | null;
  payer_name?: string | null;
  payer_doc?: string | null;
  telegram_id?: number | null;
  payload_id?: string | null;
  plan_name?: string | null;
  meta?: Record<string, unknown>;
}

export interface SetPaymentStatusOptions {
  end_to_end_id?: string | null;
  payer_name?: string | null;
  payer_doc?: string | null;
}

function mapRow(row: any): PaymentTransaction {
  return {
    id: Number(row.id),
    gateway: row.gateway,
    external_id: row.external_id,
    status: row.status,
    value_cents: Number(row.value_cents),
    qr_code: row.qr_code ?? null,
    qr_code_base64: row.qr_code_base64 ?? null,
    webhook_url: row.webhook_url ?? null,
    end_to_end_id: row.end_to_end_id ?? null,
    payer_name: row.payer_name ?? null,
    payer_doc: row.payer_doc ?? null,
    telegram_id: row.telegram_id !== null && row.telegram_id !== undefined ? Number(row.telegram_id) : null,
    payload_id: row.payload_id ?? null,
    plan_name: row.plan_name ?? null,
    meta: row.meta ?? {},
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

export async function insertOrUpdatePayment(params: InsertPaymentParams): Promise<PaymentTransaction> {
  const pix_trace_id = generatePixTraceId(params.external_id, null);
  const bot_slug = params.meta && 'bot_slug' in params.meta ? String(params.meta.bot_slug) : null;

  const result = await pool.query(
    `INSERT INTO payment_transactions
       (gateway, external_id, status, value_cents, qr_code, qr_code_base64, webhook_url,
        end_to_end_id, payer_name, payer_doc, telegram_id, payload_id, plan_name, meta)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, COALESCE($14::jsonb, '{}'::jsonb))
     ON CONFLICT (gateway, external_id) DO UPDATE
       SET status = EXCLUDED.status,
           qr_code = EXCLUDED.qr_code,
           qr_code_base64 = EXCLUDED.qr_code_base64,
           webhook_url = EXCLUDED.webhook_url,
           end_to_end_id = COALESCE(EXCLUDED.end_to_end_id, payment_transactions.end_to_end_id),
           payer_name = COALESCE(EXCLUDED.payer_name, payment_transactions.payer_name),
           payer_doc = COALESCE(EXCLUDED.payer_doc, payment_transactions.payer_doc),
           plan_name = COALESCE(EXCLUDED.plan_name, payment_transactions.plan_name),
           meta = payment_transactions.meta || EXCLUDED.meta,
           updated_at = now()
     RETURNING *`,
    [
      params.gateway,
      params.external_id,
      params.status,
      params.value_cents,
      params.qr_code ?? null,
      params.qr_code_base64 ?? null,
      params.webhook_url ?? null,
      params.end_to_end_id ?? null,
      params.payer_name ?? null,
      params.payer_doc ?? null,
      params.telegram_id ?? null,
      params.payload_id ?? null,
      params.plan_name ?? null,
      params.meta ? JSON.stringify(params.meta) : '{}',
    ]
  );

  const saved = mapRow(result.rows[0]);

  // Log DB insert/update
  logger.child({
    op: 'db',
    provider: params.gateway,
    provider_id: params.external_id,
    transaction_id: saved.id,
    bot_slug,
    telegram_id: params.telegram_id ?? null,
    payload_id: params.payload_id ?? null,
    pix_trace_id,
  }).info({
    status_next: params.status,
    price_cents: params.value_cents,
  }, '[PIX][DB] insert/update');

  return saved;
}

export async function setPaymentStatus(
  gateway: string,
  external_id: string,
  status: string,
  extra: SetPaymentStatusOptions = {}
): Promise<PaymentTransaction | null> {
  const pix_trace_id = generatePixTraceId(external_id, null);

  // Buscar status anterior
  const prev = await pool.query(
    'SELECT status, telegram_id, payload_id, meta FROM payment_transactions WHERE gateway = $1 AND external_id = $2',
    [gateway, external_id]
  );
  const status_prev = prev.rows[0]?.status ?? 'unknown';

  const result = await pool.query(
    `UPDATE payment_transactions
        SET status = $3,
            end_to_end_id = COALESCE($4, end_to_end_id),
            payer_name = COALESCE($5, payer_name),
            payer_doc = COALESCE($6, payer_doc),
            updated_at = now()
      WHERE gateway = $1 AND external_id = $2
      RETURNING *`,
    [
      gateway,
      external_id,
      status,
      extra.end_to_end_id ?? null,
      extra.payer_name ?? null,
      extra.payer_doc ?? null,
    ]
  );

  if (!result.rows[0]) {
    return null;
  }

  const updated = mapRow(result.rows[0]);
  const bot_slug = updated.meta && 'bot_slug' in updated.meta ? String(updated.meta.bot_slug) : null;

  // Log DB update
  const changed_fields = [];
  if (status_prev !== status) changed_fields.push('status');
  if (extra.end_to_end_id) changed_fields.push('end_to_end_id');
  if (extra.payer_name) changed_fields.push('payer_name');
  if (extra.payer_doc) changed_fields.push('payer_doc');

  logger.child({
    op: 'db',
    provider: gateway,
    provider_id: external_id,
    transaction_id: updated.id,
    bot_slug,
    telegram_id: updated.telegram_id ?? null,
    payload_id: updated.payload_id ?? null,
    pix_trace_id,
  }).info({
    status_prev,
    status_next: status,
    changed_fields,
    confirmed_at: status.toLowerCase() === 'paid' || status.toLowerCase() === 'approved' ? new Date().toISOString() : null,
  }, '[PIX][DB] update status');

  return updated;
}

export async function getPaymentByExternalId(
  gateway: string,
  externalId: string
): Promise<PaymentTransaction | null> {
  const result = await pool.query(
    `SELECT *
       FROM payment_transactions
      WHERE gateway = $1 AND external_id = $2
      LIMIT 1`,
    [gateway, externalId]
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

const PAID_STATUSES = ['paid', 'approved', 'completed', 'confirmed'];

export async function hasPaidTransactionForUser(
  botSlug: string,
  telegramId: number
): Promise<boolean> {
  if (!Number.isFinite(telegramId)) {
    return false;
  }

  const { rows } = await pool.query(
    `SELECT 1
       FROM payment_transactions
      WHERE telegram_id = $1
        AND (meta ->> 'bot_slug') = $2
        AND LOWER(status) = ANY($3::text[])
      ORDER BY updated_at DESC
      LIMIT 1`,
    [telegramId, botSlug, PAID_STATUSES]
  );

  return rows.length > 0;
}

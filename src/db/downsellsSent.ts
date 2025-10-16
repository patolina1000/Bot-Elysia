import type { Pool, PoolClient } from 'pg';
import { pool } from './pool.js';

export interface RecordSentParams {
  bot_slug: string;
  downsell_id: number;
  telegram_id: number;
  transaction_id?: string | null;
  external_id?: string | null;
  sent_message_id?: string | null;
  plan_label?: string | null;
  price_cents?: number | null;
  status?: string | null;
  sent_at?: Date | null;
}

type Queryable = Pool | PoolClient;

function getQueryable(client?: PoolClient): Queryable {
  return client ?? pool;
}

export async function recordSent(
  params: RecordSentParams,
  client?: PoolClient
): Promise<void> {
  const queryable = getQueryable(client);

  await queryable.query(
    `INSERT INTO downsells_sent (bot_slug, downsell_id, telegram_id, transaction_id, external_id, sent_message_id, status, plan_label, price_cents, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'sent'), $8, $9, COALESCE($10, now()))
     ON CONFLICT (bot_slug, downsell_id, telegram_id) DO UPDATE
       SET transaction_id = COALESCE(EXCLUDED.transaction_id, downsells_sent.transaction_id),
           external_id = COALESCE(EXCLUDED.external_id, downsells_sent.external_id),
           sent_message_id = COALESCE(EXCLUDED.sent_message_id, downsells_sent.sent_message_id),
           status = COALESCE(EXCLUDED.status, downsells_sent.status),
           plan_label = COALESCE(EXCLUDED.plan_label, downsells_sent.plan_label),
           price_cents = COALESCE(EXCLUDED.price_cents, downsells_sent.price_cents),
           sent_at = COALESCE(EXCLUDED.sent_at, downsells_sent.sent_at)`,
    [
      params.bot_slug,
      params.downsell_id,
      params.telegram_id,
      params.transaction_id ?? null,
      params.external_id ?? null,
      params.sent_message_id ?? null,
      params.status ?? null,
      params.plan_label ?? null,
      params.price_cents ?? null,
      params.sent_at ?? null,
    ]
  );
}

export interface SetAsPaidParams {
  downsell_id: number;
  telegram_id: number;
  paid_at?: Date | null;
  bot_slug?: string | null;
}

export async function setAsPaid(params: SetAsPaidParams, client?: PoolClient): Promise<void> {
  const queryable = getQueryable(client);
  const values: Array<string | number | Date | null> = [params.downsell_id, params.telegram_id];
  const conditions = ['downsell_id = $1', 'telegram_id = $2'];

  if (params.bot_slug) {
    conditions.push(`bot_slug = $${conditions.length + 1}`);
    values.push(params.bot_slug);
  }

  const paidAtParam = params.paid_at ?? null;
  values.push(paidAtParam);
  const paidAtIndex = values.length;

  await queryable.query(
    `UPDATE downsells_sent
        SET status = 'paid',
            paid_at = COALESCE($${paidAtIndex}, paid_at, now())
      WHERE ${conditions.join(' AND ')}`,
    values
  );
}

export async function updateStatusToPaid(
  bot_slug: string,
  downsell_id: number,
  telegram_id: number,
  client?: PoolClient
): Promise<void> {
  await setAsPaid({ bot_slug, downsell_id, telegram_id }, client);
}

export async function upsertDownsellSent(
  params: RecordSentParams,
  client?: PoolClient
): Promise<void> {
  await recordSent(params, client);
}

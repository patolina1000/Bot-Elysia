import type { Pool, PoolClient } from 'pg';
import { pool } from './pool.js';

export interface RecordSentParams {
  bot_slug: string;
  downsell_id: number;
  telegram_id: number;
  transaction_id?: string | null;
  external_id?: string | null;
  sent_message_id?: string | null;
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
    `INSERT INTO downsells_sent (bot_slug, downsell_id, telegram_id, transaction_id, external_id, sent_message_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'sent')
     ON CONFLICT (bot_slug, downsell_id, telegram_id) DO UPDATE
       SET transaction_id = COALESCE(EXCLUDED.transaction_id, downsells_sent.transaction_id),
           external_id = COALESCE(EXCLUDED.external_id, downsells_sent.external_id),
           sent_message_id = COALESCE(EXCLUDED.sent_message_id, downsells_sent.sent_message_id),
           status = 'sent'`,
    [
      params.bot_slug,
      params.downsell_id,
      params.telegram_id,
      params.transaction_id ?? null,
      params.external_id ?? null,
      params.sent_message_id ?? null,
    ]
  );
}

export async function updateStatusToPaid(
  bot_slug: string,
  downsell_id: number,
  telegram_id: number,
  client?: PoolClient
): Promise<void> {
  const queryable = getQueryable(client);

  await queryable.query(
    `UPDATE downsells_sent
        SET status = 'paid'
      WHERE bot_slug = $1
        AND downsell_id = $2
        AND telegram_id = $3`,
    [bot_slug, downsell_id, telegram_id]
  );
}

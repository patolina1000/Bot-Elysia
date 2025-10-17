import type { Pool, PoolClient } from 'pg';
import { pool } from './pool.js';

export interface RecordShotSentParams {
  bot_slug: string;
  shot_id: number;
  telegram_id: number;
  message_id?: string | null;
  price_cents?: number | null;
  meta?: Record<string, any> | null;
  sent_at?: Date | null;
}

type Queryable = Pool | PoolClient;

function getQueryable(client?: PoolClient): Queryable {
  return client ?? pool;
}

export async function recordShotSent(
  params: RecordShotSentParams,
  client?: PoolClient
): Promise<void> {
  const queryable = getQueryable(client);

  await queryable.query(
    `INSERT INTO shots_sent (bot_slug, shot_id, telegram_id, message_id, price_cents, meta, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7, now()))
     ON CONFLICT (bot_slug, shot_id, telegram_id) DO UPDATE
       SET message_id = COALESCE(EXCLUDED.message_id, shots_sent.message_id),
           price_cents = COALESCE(EXCLUDED.price_cents, shots_sent.price_cents),
           meta = COALESCE(EXCLUDED.meta, shots_sent.meta),
           sent_at = COALESCE(EXCLUDED.sent_at, shots_sent.sent_at)`,
    [
      params.bot_slug,
      params.shot_id,
      params.telegram_id,
      params.message_id ?? null,
      params.price_cents ?? null,
      params.meta ? JSON.stringify(params.meta) : null,
      params.sent_at ?? null,
    ]
  );
}

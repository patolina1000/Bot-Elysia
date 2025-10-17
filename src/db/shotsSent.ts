import type { Pool, PoolClient } from 'pg';
import { pool } from './pool.js';

export interface RecordShotSentParams {
  shot_id: number;
  bot_slug: string;
  telegram_id: number;
  status: 'sent' | 'skipped' | 'error';
  error?: string | null;
}

export interface ShotStats {
  total: number;
  sent: number;
  skipped: number;
  error: number;
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
    `INSERT INTO shots_sent (shot_id, bot_slug, telegram_id, status, error, sent_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (shot_id, telegram_id) DO UPDATE
     SET status = EXCLUDED.status,
         error = EXCLUDED.error,
         sent_at = EXCLUDED.sent_at`,
    [
      params.shot_id,
      params.bot_slug,
      params.telegram_id,
      params.status,
      params.error ?? null,
    ]
  );
}

export async function getShotStats(
  shot_id: number,
  client?: PoolClient
): Promise<ShotStats> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE status = 'sent') as sent,
       COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
       COUNT(*) FILTER (WHERE status = 'error') as error
     FROM shots_sent
     WHERE shot_id = $1`,
    [shot_id]
  );

  const row = result.rows[0];
  return {
    total: Number(row.total ?? 0),
    sent: Number(row.sent ?? 0),
    skipped: Number(row.skipped ?? 0),
    error: Number(row.error ?? 0),
  };
}

export async function bulkRecordShotsSent(
  records: RecordShotSentParams[],
  client?: PoolClient
): Promise<void> {
  if (records.length === 0) return;

  const queryable = getQueryable(client);

  // Build bulk insert with proper array handling
  const values: any[] = [];
  const placeholders: string[] = [];
  
  records.forEach((record, index) => {
    const offset = index * 5;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
    values.push(
      record.shot_id,
      record.bot_slug,
      record.telegram_id,
      record.status,
      record.error ?? null
    );
  });

  await queryable.query(
    `INSERT INTO shots_sent (shot_id, bot_slug, telegram_id, status, error)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (shot_id, telegram_id) DO UPDATE
     SET status = EXCLUDED.status,
         error = EXCLUDED.error,
         sent_at = now()`,
    values
  );
}

import type { Pool, PoolClient, QueryResult } from 'pg';
import { pool } from './pool.js';

export type ShotQueueStatus = 'scheduled' | 'sending' | 'sent' | 'skipped' | 'error';

export interface ShotQueueJob {
  id: number;
  bot_slug: string;
  shot_id: number;
  telegram_id: number;
  deliver_at: Date;
  status: ShotQueueStatus;
  skip_reason: string | null;
  attempt_count: number;
  last_error: string | null;
  sent_message_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueShotParams {
  bot_slug: string;
  shot_id: number;
  telegram_id: number;
  deliver_at: Date;
}

export interface PickedJobs {
  client: PoolClient;
  jobs: ShotQueueJob[];
}

type Queryable = Pool | PoolClient;

function getQueryable(client?: PoolClient): Queryable {
  return client ?? pool;
}

function mapRow(row: any): ShotQueueJob {
  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    shot_id: Number(row.shot_id),
    telegram_id: Number(row.telegram_id),
    deliver_at: row.deliver_at instanceof Date ? row.deliver_at : new Date(row.deliver_at),
    status: String(row.status) as ShotQueueStatus,
    skip_reason: row.skip_reason ?? null,
    attempt_count: Number(row.attempt_count ?? 0),
    last_error: row.last_error ?? null,
    sent_message_id: row.sent_message_id ?? null,
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

function normalizeUpsertResult(result: QueryResult<any>): ShotQueueJob | null {
  const row = result.rows?.[0];
  return row ? mapRow(row) : null;
}

export async function enqueueShotJob(
  params: EnqueueShotParams,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `INSERT INTO shots_queue (
         bot_slug, shot_id, telegram_id, deliver_at,
         status, attempt_count
       )
       VALUES ($1, $2, $3, $4, 'scheduled', 0)
     ON CONFLICT (shot_id, telegram_id) DO UPDATE
       SET deliver_at = EXCLUDED.deliver_at,
           status = 'scheduled',
           attempt_count = 0,
           last_error = NULL,
           skip_reason = NULL,
           sent_message_id = NULL,
           updated_at = now()
     RETURNING *`,
    [params.bot_slug, params.shot_id, params.telegram_id, params.deliver_at]
  );

  return normalizeUpsertResult(result);
}

export async function insertShotJobsBulk(
  jobs: EnqueueShotParams[],
  client?: PoolClient
): Promise<number> {
  if (jobs.length === 0) return 0;

  const queryable = getQueryable(client);

  const values: any[] = [];
  const placeholders: string[] = [];
  
  jobs.forEach((job, idx) => {
    const base = idx * 4;
    placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    values.push(job.bot_slug, job.shot_id, job.telegram_id, job.deliver_at);
  });

  const result = await queryable.query(
    `INSERT INTO shots_queue (bot_slug, shot_id, telegram_id, deliver_at, status, attempt_count)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (shot_id, telegram_id) DO UPDATE
       SET deliver_at = EXCLUDED.deliver_at,
           status = 'scheduled',
           attempt_count = 0,
           last_error = NULL,
           skip_reason = NULL,
           sent_message_id = NULL,
           updated_at = now()`,
    values
  );

  return result.rowCount ?? 0;
}

export async function listDueShotJobs(limit: number): Promise<PickedJobs | null> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT *
         FROM shots_queue
        WHERE status = 'scheduled'
          AND deliver_at <= now()
        ORDER BY deliver_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit]
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      client.release();
      return null;
    }

    const jobs = rows.map(mapRow);
    return { client, jobs };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    throw err;
  }
}

export async function markShotJobAsSending(
  id: number,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `UPDATE shots_queue
        SET status = 'sending',
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id]
  );

  return normalizeUpsertResult(result);
}

export async function markShotJobAsSent(
  id: number,
  sentMessageId?: string | null,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `UPDATE shots_queue
        SET status = 'sent',
            sent_message_id = $2,
            updated_at = now(),
            last_error = NULL
      WHERE id = $1
      RETURNING *`,
    [id, sentMessageId ?? null]
  );

  return normalizeUpsertResult(result);
}

export async function markShotJobAsSkipped(
  id: number,
  reason: string,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `UPDATE shots_queue
        SET status = 'skipped',
            skip_reason = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, reason]
  );

  return normalizeUpsertResult(result);
}

export async function markShotJobAsError(
  id: number,
  error: unknown,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');

  const result = await queryable.query(
    `UPDATE shots_queue
        SET status = 'error',
            last_error = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, message]
  );

  return normalizeUpsertResult(result);
}

export async function incrementShotAttempt(
  id: number,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `UPDATE shots_queue
        SET attempt_count = attempt_count + 1,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id]
  );

  return normalizeUpsertResult(result);
}

export async function alreadyShotToUser(
  bot_slug: string,
  shot_id: number,
  telegram_id: number,
  client?: PoolClient
): Promise<boolean> {
  const queryable = getQueryable(client);

  const { rows } = await queryable.query(
    `SELECT 1
       FROM shots_sent
      WHERE bot_slug = $1
        AND shot_id = $2
        AND telegram_id = $3
      LIMIT 1`,
    [bot_slug, shot_id, telegram_id]
  );

  return rows.length > 0;
}

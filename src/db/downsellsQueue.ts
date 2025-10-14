import type { Pool, PoolClient, QueryResult } from 'pg';
import { pool } from './pool.js';

export type DownsellQueueStatus = 'pending' | 'sent' | 'skipped' | 'error';

export interface DownsellQueueJob {
  id: number;
  bot_slug: string;
  downsell_id: number;
  telegram_id: number;
  deliver_at: Date;
  status: DownsellQueueStatus;
  attempt_count: number;
  last_error: string | null;
  transaction_id: string | null;
  external_id: string | null;
  sent_message_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueDownsellParams {
  bot_slug: string;
  downsell_id: number;
  telegram_id: number;
  deliver_at: Date;
}

export interface MarkJobAsSentParams {
  transaction_id?: string | null;
  external_id?: string | null;
  sent_message_id?: string | null;
}

export interface PickedJobs {
  client: PoolClient;
  jobs: DownsellQueueJob[];
}

type Queryable = Pool | PoolClient;

function getQueryable(client?: PoolClient): Queryable {
  return client ?? pool;
}

function mapRow(row: any): DownsellQueueJob {
  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    downsell_id: Number(row.downsell_id),
    telegram_id: Number(row.telegram_id),
    deliver_at: row.deliver_at instanceof Date ? row.deliver_at : new Date(row.deliver_at),
    status: String(row.status) as DownsellQueueStatus,
    attempt_count: Number(row.attempt_count ?? 0),
    last_error: row.last_error ?? null,
    transaction_id: row.transaction_id ?? null,
    external_id: row.external_id ?? null,
    sent_message_id: row.sent_message_id ?? null,
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

function normalizeUpsertResult(result: QueryResult<any>): DownsellQueueJob | null {
  const row = result.rows?.[0];
  return row ? mapRow(row) : null;
}

export async function enqueueDownsell(
  params: EnqueueDownsellParams,
  client?: PoolClient
): Promise<DownsellQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `INSERT INTO downsells_queue (bot_slug, downsell_id, telegram_id, deliver_at, status, attempt_count, last_error)
       VALUES ($1, $2, $3, $4, 'pending', 0, NULL)
     ON CONFLICT (bot_slug, downsell_id, telegram_id) DO UPDATE
       SET deliver_at = EXCLUDED.deliver_at,
           status = 'pending',
           attempt_count = 0,
           last_error = NULL,
           transaction_id = NULL,
           external_id = NULL,
           sent_message_id = NULL,
           updated_at = now()
     RETURNING *`,
    [params.bot_slug, params.downsell_id, params.telegram_id, params.deliver_at]
  );

  return normalizeUpsertResult(result);
}

export async function pickDueJobs(limit: number): Promise<PickedJobs | null> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT *
         FROM downsells_queue
        WHERE status = 'pending'
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

export async function markJobAsSent(
  id: number,
  details: MarkJobAsSentParams = {},
  client?: PoolClient
): Promise<DownsellQueueJob | null> {
  const queryable = getQueryable(client);
  const transactionId = details.transaction_id ?? null;
  const externalId = details.external_id ?? null;
  const sentMessageId = details.sent_message_id ?? null;

  const result = await queryable.query(
    `UPDATE downsells_queue
        SET status = 'sent',
            transaction_id = $2,
            external_id = $3,
            sent_message_id = $4,
            updated_at = now(),
            last_error = NULL
      WHERE id = $1
      RETURNING *`,
    [id, transactionId, externalId, sentMessageId]
  );

  return normalizeUpsertResult(result);
}

export async function markJobAsSkipped(
  id: number,
  reason: string,
  client?: PoolClient
): Promise<DownsellQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `UPDATE downsells_queue
        SET status = 'skipped',
            last_error = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, reason]
  );

  return normalizeUpsertResult(result);
}

export async function markJobAsError(
  id: number,
  error: unknown,
  client?: PoolClient
): Promise<DownsellQueueJob | null> {
  const queryable = getQueryable(client);
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');

  const result = await queryable.query(
    `UPDATE downsells_queue
        SET status = 'error',
            last_error = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, message]
  );

  return normalizeUpsertResult(result);
}

export async function incrementAttempt(id: number, client?: PoolClient): Promise<DownsellQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `UPDATE downsells_queue
        SET attempt_count = attempt_count + 1,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id]
  );

  return normalizeUpsertResult(result);
}

export async function alreadySent(
  bot_slug: string,
  downsell_id: number,
  telegram_id: number,
  client?: PoolClient
): Promise<boolean> {
  const queryable = getQueryable(client);

  const { rows } = await queryable.query(
    `SELECT 1
       FROM downsells_sent
      WHERE bot_slug = $1
        AND downsell_id = $2
        AND telegram_id = $3
      LIMIT 1`,
    [bot_slug, downsell_id, telegram_id]
  );

  return rows.length > 0;
}

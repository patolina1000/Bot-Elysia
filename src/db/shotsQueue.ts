import type { Pool, PoolClient, QueryResult } from 'pg';
import { pool } from './pool.js';

export type ShotTarget = 'started' | 'pix_created';
export type ShotStatus =
  | 'pending'
  | 'processing'
  | 'success'
  | 'error'
  | 'running'
  | 'sent'
  | 'skipped';
export type MediaType = 'photo' | 'video' | 'audio' | 'document' | 'none';

export interface ShotQueueJob {
  id: number;
  shot_id: number | null;
  bot_slug: string;
  target: ShotTarget | null;
  copy: string;
  media_url: string | null;
  media_type: MediaType;
  telegram_id: number | null;
  scheduled_at: Date | null;
  status: ShotStatus;
  attempt_count: number;
  attempts: number;
  next_retry_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateShotParams {
  bot_slug: string;
  target: ShotTarget;
  copy: string;
  media_url?: string | null;
  media_type?: MediaType;
  scheduled_at?: Date;
}

export interface UpdateShotParams {
  copy?: string;
  media_url?: string | null;
  media_type?: MediaType;
  scheduled_at?: Date;
}

type Queryable = Pool | PoolClient;

function getQueryable(client?: PoolClient): Queryable {
  return client ?? pool;
}

function parseDate(value: any): Date | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mapRow(row: any): ShotQueueJob {
  const attemptsValue = Number(row.attempts ?? row.attempt_count ?? 0);
  return {
    id: Number(row.id),
    shot_id: row.shot_id !== undefined && row.shot_id !== null ? Number(row.shot_id) : null,
    bot_slug: String(row.bot_slug),
    target: row.target ? (String(row.target) as ShotTarget) : null,
    copy: String(row.copy ?? ''),
    media_url: row.media_url ?? null,
    media_type: String(row.media_type ?? 'none') as MediaType,
    telegram_id:
      row.telegram_id !== undefined && row.telegram_id !== null ? Number(row.telegram_id) : null,
    scheduled_at: parseDate(row.scheduled_at),
    status: String(row.status) as ShotStatus,
    attempt_count: attemptsValue,
    attempts: attemptsValue,
    next_retry_at: parseDate(row.next_retry_at),
    last_error: row.last_error ?? null,
    created_at: parseDate(row.created_at) ?? new Date(),
    updated_at: parseDate(row.updated_at) ?? new Date(),
  };
}

export async function createShot(
  params: CreateShotParams,
  client?: PoolClient
): Promise<ShotQueueJob> {
  const queryable = getQueryable(client);
  
  const result = await queryable.query(
    `INSERT INTO shots_queue (
       bot_slug, target, copy, media_url, media_type, scheduled_at,
       status, attempt_count
     )
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), 'pending', 0)
     RETURNING *`,
    [
      params.bot_slug,
      params.target,
      params.copy,
      params.media_url ?? null,
      params.media_type ?? 'none',
      params.scheduled_at ?? null,
    ]
  );

  return mapRow(result.rows[0]);
}

export async function listShots(
  bot_slug: string,
  limit = 50,
  client?: PoolClient
): Promise<ShotQueueJob[]> {
  const queryable = getQueryable(client);
  
  const result = await queryable.query(
    `SELECT *
     FROM shots_queue
     WHERE bot_slug = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [bot_slug, limit]
  );

  return result.rows.map(mapRow);
}

export async function getShotById(
  id: number,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);
  
  const result = await queryable.query(
    `SELECT * FROM shots_queue WHERE id = $1`,
    [id]
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function updateShot(
  id: number,
  params: UpdateShotParams,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);
  
  // Build dynamic update query
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (params.copy !== undefined) {
    updates.push(`copy = $${paramIndex++}`);
    values.push(params.copy);
  }
  if (params.media_url !== undefined) {
    updates.push(`media_url = $${paramIndex++}`);
    values.push(params.media_url);
  }
  if (params.media_type !== undefined) {
    updates.push(`media_type = $${paramIndex++}`);
    values.push(params.media_type);
  }
  if (params.scheduled_at !== undefined) {
    updates.push(`scheduled_at = $${paramIndex++}`);
    values.push(params.scheduled_at);
  }

  if (updates.length === 0) {
    return getShotById(id, client);
  }

  values.push(id);
  
  const result = await queryable.query(
    `UPDATE shots_queue
     SET ${updates.join(', ')}
     WHERE id = $${paramIndex} AND status = 'pending'
     RETURNING *`,
    values
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function deleteShot(
  id: number,
  client?: PoolClient
): Promise<boolean> {
  const queryable = getQueryable(client);
  
  const result = await queryable.query(
    `DELETE FROM shots_queue
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [id]
  );

  return result.rowCount !== null && result.rowCount > 0;
}

export interface PickedShotQueueJobs {
  client: PoolClient;
  jobs: ShotQueueJob[];
}

export async function pickDueShotQueueJobs(limit: number): Promise<PickedShotQueueJobs | null> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT *
       FROM shots_queue
       WHERE status = 'pending'
         AND (scheduled_at IS NULL OR scheduled_at <= now())
         AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY scheduled_at NULLS FIRST, id ASC
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

export async function markShotQueueProcessing(
  id: number,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `UPDATE shots_queue
     SET status = 'processing',
         attempts = COALESCE(attempts, 0) + 1,
         last_error = NULL,
         next_retry_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function markShotQueueSuccess(
  id: number,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `UPDATE shots_queue
     SET status = 'success',
         last_error = NULL,
         next_retry_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function markShotQueueError(
  id: number,
  error: string,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);
  const message = typeof error === 'string' ? error : String(error ?? 'unknown error');

  const result = await queryable.query(
    `UPDATE shots_queue
     SET status = 'error',
         last_error = $2,
         next_retry_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id, message]
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function scheduleShotQueueRetry(
  id: number,
  error: string,
  nextRetryAt: Date,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);
  const message = typeof error === 'string' ? error : String(error ?? 'unknown error');

  const result = await queryable.query(
    `UPDATE shots_queue
     SET status = 'pending',
         last_error = $2,
         next_retry_at = $3
     WHERE id = $1
     RETURNING *`,
    [id, message, nextRetryAt]
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function incrementShotQueueAttempt(
  id: number,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);

  const result = await queryable.query(
    `UPDATE shots_queue
     SET attempts = COALESCE(attempts, 0) + 1
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function resetStuckShotQueueJobs(timeoutMinutes = 30, maxAttempts = 3): Promise<number> {
  const result = await pool.query(
    `UPDATE shots_queue
     SET status = 'pending',
         attempts = COALESCE(attempts, 0) + 1
     WHERE status IN ('processing', 'running')
       AND updated_at < now() - interval '${timeoutMinutes} minutes'
       AND COALESCE(attempts, attempt_count, 0) < $1
     RETURNING id`,
    [maxAttempts]
  );

  return result.rowCount ?? 0;
}

export async function pickPendingShot(
  client?: PoolClient
): Promise<{ client: PoolClient; job: ShotQueueJob } | null> {
  const picked = await pickDueShotQueueJobs(1);
  if (!picked) {
    return null;
  }

  const { client: pooledClient, jobs } = picked;
  const [job] = jobs;
  return { client: pooledClient, job };
}

export const markShotAsSent = markShotQueueSuccess;
export const markShotAsError = markShotQueueError;
export const incrementShotAttempt = incrementShotQueueAttempt;
export const resetStuckJobs = resetStuckShotQueueJobs;

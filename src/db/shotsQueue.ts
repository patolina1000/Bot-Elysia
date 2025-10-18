import type { Pool, PoolClient, QueryResult } from 'pg';
import { pool } from './pool.js';

export type ShotTarget = 'started' | 'pix_created';
export type ShotStatus = 'pending' | 'running' | 'sent' | 'skipped' | 'error';
export type MediaType = 'photo' | 'video' | 'audio' | 'document' | 'none';

export interface ShotQueueJob {
  id: number;
  bot_slug: string;
  target: ShotTarget;
  copy: string;
  media_url: string | null;
  media_type: MediaType;
  scheduled_at: Date;
  status: ShotStatus;
  attempt_count: number;
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

function mapRow(row: any): ShotQueueJob {
  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    target: String(row.target) as ShotTarget,
    copy: String(row.copy),
    media_url: row.media_url ?? null,
    media_type: String(row.media_type ?? 'none') as MediaType,
    scheduled_at: row.scheduled_at instanceof Date ? row.scheduled_at : new Date(row.scheduled_at),
    status: String(row.status) as ShotStatus,
    attempt_count: Number(row.attempt_count ?? 0),
    last_error: row.last_error ?? null,
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
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

export async function pickPendingShot(client?: PoolClient): Promise<{ client: PoolClient; job: ShotQueueJob } | null> {
  const poolClient = client ?? await pool.connect();
  
  try {
    await poolClient.query('BEGIN');

    const { rows } = await poolClient.query(
      `UPDATE shots_queue
       SET status = 'running', updated_at = now()
       WHERE id = (
         SELECT id
         FROM shots_queue
         WHERE status = 'pending'
           AND scheduled_at <= now()
         ORDER BY scheduled_at ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    );

    if (rows.length === 0) {
      await poolClient.query('COMMIT');
      if (!client) poolClient.release();
      return null;
    }

    const job = mapRow(rows[0]);
    return { client: poolClient, job };
  } catch (err) {
    await poolClient.query('ROLLBACK').catch(() => undefined);
    if (!client) poolClient.release();
    throw err;
  }
}

export async function markShotAsSent(
  id: number,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);
  
  const result = await queryable.query(
    `UPDATE shots_queue
     SET status = 'sent', last_error = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function markShotAsError(
  id: number,
  error: string,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);
  
  const result = await queryable.query(
    `UPDATE shots_queue
     SET status = 'error',
         last_error = $2,
         attempt_count = attempt_count + 1,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, error]
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function incrementShotAttempt(
  id: number,
  client?: PoolClient
): Promise<ShotQueueJob | null> {
  const queryable = getQueryable(client);
  
  const result = await queryable.query(
    `UPDATE shots_queue
     SET attempt_count = attempt_count + 1, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

// Reset stuck jobs (running for more than 30 minutes)
export async function resetStuckJobs(timeoutMinutes = 30): Promise<number> {
  const result = await pool.query(
    `UPDATE shots_queue
     SET status = 'pending',
         attempt_count = attempt_count + 1,
         updated_at = now()
     WHERE status = 'running'
       AND updated_at < now() - interval '${timeoutMinutes} minutes'
       AND attempt_count < 3
     RETURNING id`
  );

  return result.rowCount ?? 0;
}

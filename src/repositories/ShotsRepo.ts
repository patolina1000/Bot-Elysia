import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

export type ShotTarget = 'all_started' | 'pix_generated';
export type ShotMediaType = 'photo' | 'video' | 'audio' | 'document' | 'none';

export type ShotRow = {
  id: number;
  bot_slug: string;
  title: string | null;
  copy: string | null;
  media_url: string | null;
  media_type: ShotMediaType | null;
  target: ShotTarget | string;
  scheduled_at: Date | null;
  created_at: Date | null;
};

export type ShotPlanRow = {
  id: number;
  shot_id: number;
  name: string;
  price_cents: number;
  description: string | null;
  sort_order: number;
};

export type ShotQueueStats = {
  queued: number;
  processing: number;
  success: number;
  error: number;
};

export type ShotListItem = ShotRow & { queue_stats: ShotQueueStats };

function toNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeMediaType(value: unknown): ShotMediaType | null {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'photo' || normalized === 'video' || normalized === 'audio' || normalized === 'document') {
    return normalized;
  }
  if (normalized === 'none' || normalized === '' || value == null) {
    return 'none';
  }
  return 'none';
}

function mapTarget(value: unknown): ShotTarget | string {
  if (typeof value !== 'string') {
    return 'all_started';
  }
  const normalized = value.toLowerCase();
  if (normalized === 'all_started' || normalized === 'started') {
    return 'all_started';
  }
  if (normalized === 'pix_generated' || normalized === 'pix_created') {
    return 'pix_generated';
  }
  return normalized;
}

function mapShotRow(row: any): ShotRow {
  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    title: row.title ?? null,
    copy: row.copy ?? null,
    media_url: row.media_url ?? null,
    media_type: normalizeMediaType(row.media_type),
    target: mapTarget(row.target),
    scheduled_at: row.scheduled_at ? new Date(row.scheduled_at) : null,
    created_at: row.created_at ? new Date(row.created_at) : null,
  };
}

function emptyStats(): ShotQueueStats {
  return { queued: 0, processing: 0, success: 0, error: 0 };
}

function mapQueueStatus(value: unknown): keyof ShotQueueStats {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'pending' || normalized === 'queued' || normalized === 'scheduled') {
    return 'queued';
  }
  if (normalized === 'processing' || normalized === 'running') {
    return 'processing';
  }
  if (normalized === 'success' || normalized === 'sent') {
    return 'success';
  }
  return 'error';
}

export interface ListShotsParams {
  botSlug: string;
  search?: string | null;
  limit: number;
  offset: number;
}

export interface ListShotsResult {
  items: ShotListItem[];
  total: number;
}

export async function listShots(params: ListShotsParams): Promise<ListShotsResult> {
  const { botSlug, search, limit, offset } = params;

  const searchQuery = search?.trim();
  const values: Array<string | number> = [botSlug];
  let whereClause = 'bot_slug = $1';

  if (searchQuery) {
    values.push(`%${searchQuery}%`);
    whereClause += ` AND (title ILIKE $${values.length} OR copy ILIKE $${values.length})`;
  }

  values.push(limit);
  values.push(offset);

  const listQuery = `
    SELECT id, bot_slug, title, copy, media_url, media_type, target, scheduled_at, created_at
    FROM shots
    WHERE ${whereClause}
    ORDER BY created_at DESC NULLS LAST, id DESC
    LIMIT $${values.length - 1}
    OFFSET $${values.length}
  `;

  const [listResult, countResult] = await Promise.all([
    pool.query(listQuery, values),
    pool.query(
      `SELECT COUNT(*) AS total FROM shots WHERE ${whereClause}`,
      values.slice(0, searchQuery ? 2 : 1)
    ),
  ]);

  const shotRows = listResult.rows.map(mapShotRow);
  const total = Number(countResult.rows[0]?.total ?? 0);

  if (shotRows.length === 0) {
    return { items: [], total };
  }

  const statsResult = await pool.query(
    `SELECT shot_id, status, COUNT(*) AS count
     FROM shots_queue
     WHERE shot_id = ANY($1::bigint[])
     GROUP BY shot_id, status`,
    [shotRows.map((shot) => shot.id)]
  );

  const statsMap = new Map<number, ShotQueueStats>();

  for (const row of statsResult.rows) {
    const shotId = Number(row.shot_id);
    const statusKey = mapQueueStatus(row.status);
    const count = toNumber(row.count) ?? 0;
    const current = statsMap.get(shotId) ?? emptyStats();
    current[statusKey] += count;
    statsMap.set(shotId, current);
  }

  const items: ShotListItem[] = shotRows.map((shot) => ({
    ...shot,
    queue_stats: statsMap.get(shot.id) ?? emptyStats(),
  }));

  return { items, total };
}

export async function getShotWithPlans(
  shotId: number
): Promise<{ shot: ShotRow; plans: ShotPlanRow[] }> {
  if (!Number.isInteger(shotId) || shotId <= 0) {
    throw new Error('shotId must be a positive integer');
  }

  const shotResult = await pool.query(
    `SELECT id, bot_slug, title, copy, media_url, media_type, target, scheduled_at, created_at
     FROM shots
     WHERE id = $1
     LIMIT 1`,
    [shotId]
  );

  if (shotResult.rows.length === 0) {
    throw new Error(`Shot not found for id ${shotId}`);
  }

  const plansResult = await pool.query<ShotPlanRow>(
    `SELECT id, shot_id, name, price_cents, description, sort_order
     FROM shot_plans
     WHERE shot_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [shotId]
  );

  const plans = plansResult.rows.map((plan) => ({
    ...plan,
    price_cents: Number.isFinite(plan.price_cents) ? Number(plan.price_cents) : 0,
    sort_order: Number.isFinite(plan.sort_order) ? Number(plan.sort_order) : 0,
  }));

  logger.info(`[SHOTS][LOAD] shotId=${shotId} plans=${plans.length}`);

  return {
    shot: mapShotRow(shotResult.rows[0]),
    plans,
  };
}

export async function findShotById(shotId: number): Promise<ShotRow | null> {
  if (!Number.isInteger(shotId) || shotId <= 0) {
    return null;
  }

  const { rows } = await pool.query(
    `SELECT id, bot_slug, title, copy, media_url, media_type, target, scheduled_at, created_at
     FROM shots
     WHERE id = $1
     LIMIT 1`,
    [shotId]
  );

  return rows.length > 0 ? mapShotRow(rows[0]) : null;
}

export interface CreateShotInput {
  bot_slug: string;
  title: string | null;
  copy: string | null;
  media_url: string | null;
  media_type: ShotMediaType;
  target: ShotTarget;
  scheduled_at: Date | null;
}

export async function createShot(input: CreateShotInput): Promise<ShotRow> {
  const { rows } = await pool.query(
    `INSERT INTO shots (bot_slug, title, copy, media_url, media_type, target, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, bot_slug, title, copy, media_url, media_type, target, scheduled_at, created_at`,
    [
      input.bot_slug,
      input.title,
      input.copy,
      input.media_url,
      input.media_type,
      input.target,
      input.scheduled_at,
    ]
  );

  return mapShotRow(rows[0]);
}

export interface UpdateShotInput {
  bot_slug?: string;
  title?: string | null;
  copy?: string | null;
  media_url?: string | null;
  media_type?: ShotMediaType;
  target?: ShotTarget;
  scheduled_at?: Date | null;
}

export async function updateShot(shotId: number, input: UpdateShotInput): Promise<ShotRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    sets.push(`${key} = $${index}`);
    values.push(value);
    index += 1;
  }

  if (sets.length === 0) {
    return findShotById(shotId);
  }

  values.push(shotId);

  const { rows } = await pool.query(
    `UPDATE shots
     SET ${sets.join(', ')}
     WHERE id = $${index}
     RETURNING id, bot_slug, title, copy, media_url, media_type, target, scheduled_at, created_at`,
    values
  );

  return rows.length > 0 ? mapShotRow(rows[0]) : null;
}

export async function deleteShot(shotId: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM shots WHERE id = $1', [shotId]);
  return (result.rowCount ?? 0) > 0;
}

export async function botExists(botSlug: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM bots WHERE slug = $1 LIMIT 1', [botSlug]);
  return rows.length > 0;
}

export async function shotHasQueueEntries(shotId: number): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM shots_queue WHERE shot_id = $1 LIMIT 1', [shotId]);
  return rows.length > 0;
}

export async function shotHasSuccessfulQueue(shotId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1
     FROM shots_queue
     WHERE shot_id = $1
       AND status IN ('success', 'sent')
     LIMIT 1`,
    [shotId]
  );
  return rows.length > 0;
}

export async function getQueueStats(shotId: number): Promise<ShotQueueStats> {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*) AS count
     FROM shots_queue
     WHERE shot_id = $1
     GROUP BY status`,
    [shotId]
  );

  const stats = emptyStats();
  for (const row of rows) {
    const key = mapQueueStatus(row.status);
    stats[key] += toNumber(row.count) ?? 0;
  }

  return stats;
}


import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

export interface ShotRecord {
  id: number;
  bot_slug: string;
  title: string | null;
  copy: string | null;
  media_url: string | null;
  media_type: string | null;
  scheduled_at: Date | null;
  target: string | null;
}

export interface ShotPlanRecord {
  id: number;
  name: string;
  price_cents: number | null;
  description: string | null;
  sort_order: number | null;
}

export interface ShotWithPlansResult {
  shot: ShotRecord;
  plans: ShotPlanRecord[];
}

export async function getShotWithPlans(shotId: number): Promise<ShotWithPlansResult> {
  if (!Number.isInteger(shotId) || shotId <= 0) {
    throw new Error('shotId must be a positive integer');
  }

  const shotResult = await pool.query<ShotRecord>(
    `SELECT id, bot_slug, title, copy, media_url, media_type, scheduled_at, target
     FROM shots
     WHERE id = $1
     LIMIT 1`,
    [shotId]
  );

  if (shotResult.rows.length === 0) {
    throw new Error(`Shot not found for id ${shotId}`);
  }

  const plansResult = await pool.query<ShotPlanRecord>(
    `SELECT id, name, price_cents, description, sort_order
     FROM shot_plans
     WHERE shot_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [shotId]
  );

  const plans = plansResult.rows;

  logger.debug(`[SHOTS][LOAD] shotId=${shotId} plans=${plans.length}`);

  return {
    shot: shotResult.rows[0],
    plans,
  };
}

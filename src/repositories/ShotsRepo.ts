import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

export type ShotRow = {
  id: number;
  bot_slug: string;
  title: string | null;
  copy: string | null;
  media_url: string | null;
  media_type: 'photo' | 'video' | 'audio' | 'document' | 'none' | null;
  target: 'all_started' | 'pix_generated';
  scheduled_at: Date | null;
};

export type ShotPlanRow = {
  id: number;
  shot_id: number;
  name: string;
  price_cents: number;
  description: string | null;
  sort_order: number;
};

export async function getShotWithPlans(
  shotId: number
): Promise<{ shot: ShotRow; plans: ShotPlanRow[] }> {
  if (!Number.isInteger(shotId) || shotId <= 0) {
    throw new Error('shotId must be a positive integer');
  }

  const shotResult = await pool.query<ShotRow>(
    `SELECT id, bot_slug, title, copy, media_url, media_type, target, scheduled_at
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
    shot: {
      ...shotResult.rows[0],
      media_type: (shotResult.rows[0]?.media_type ?? null) as ShotRow['media_type'],
    },
    plans,
  };
}

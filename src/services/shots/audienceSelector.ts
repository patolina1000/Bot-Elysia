import { pool } from '../../db/pool.js';
import type { ShotTarget } from '../../db/shotsQueue.js';
import { logger } from '../../logger.js';

export interface AudienceParams {
  bot_slug: string;
  target: ShotTarget;
  recencyDays?: number; // Optional: filter by last_interaction_at
}

export interface AudienceMember {
  telegram_id: number;
  last_interaction_at: Date | null;
}

/**
 * Select audience based on target criteria:
 * - 'started': Users who have /start (telegram_contacts with chat_state != 'blocked')
 * - 'pix_created': Users who created a PIX (from funnel_events or payment_transactions)
 * 
 * Always excludes chat_state IN ('blocked', 'deactivated')
 * Orders by last_interaction_at DESC (hot leads first)
 */
export async function selectAudience(params: AudienceParams): Promise<AudienceMember[]> {
  const { bot_slug, target, recencyDays } = params;

  logger.info(
    { bot_slug, target, recencyDays },
    '[SHOTS][AUDIENCE] selecting audience'
  );

  if (target === 'started') {
    return selectStartedAudience(bot_slug, recencyDays);
  } else if (target === 'pix_created') {
    return selectPixCreatedAudience(bot_slug, recencyDays);
  }

  throw new Error(`Unknown target: ${target}`);
}

/**
 * Target: started
 * Users who have contacted the bot (telegram_contacts) and are not blocked
 */
async function selectStartedAudience(
  bot_slug: string,
  recencyDays?: number
): Promise<AudienceMember[]> {
  let query = `
    SELECT 
      telegram_id,
      last_interaction_at
    FROM telegram_contacts
    WHERE bot_slug = $1
      AND chat_state NOT IN ('blocked', 'deactivated')
  `;

  const params: any[] = [bot_slug];

  if (recencyDays && recencyDays > 0) {
    query += ` AND last_interaction_at >= now() - interval '${recencyDays} days'`;
  }

  query += ` ORDER BY last_interaction_at DESC NULLS LAST`;

  const { rows } = await pool.query(query, params);

  logger.info(
    { bot_slug, count: rows.length, recencyDays },
    '[SHOTS][AUDIENCE] started audience selected'
  );

  return rows.map((row) => ({
    telegram_id: Number(row.telegram_id),
    last_interaction_at: row.last_interaction_at
      ? new Date(row.last_interaction_at)
      : null,
  }));
}

/**
 * Target: pix_created
 * Users who created a PIX (have funnel_events with 'pix_created' or payment_transactions)
 * Intersected with telegram_contacts (chat_state != blocked)
 */
async function selectPixCreatedAudience(
  bot_slug: string,
  recencyDays?: number
): Promise<AudienceMember[]> {
  // Strategy: Find users with PIX created from funnel_events or payment_transactions
  // Then join with telegram_contacts to exclude blocked users
  
  let query = `
    WITH pix_users AS (
      SELECT DISTINCT tg_user_id
      FROM funnel_events
      WHERE bot_slug = $1
        AND event IN ('pix_created', 'checkout_pix_created')
        AND tg_user_id IS NOT NULL
      
      UNION
      
      SELECT DISTINCT telegram_id AS tg_user_id
      FROM payment_transactions
      WHERE bot_slug = $1
        AND status IN ('created', 'paid')
        AND telegram_id IS NOT NULL
    )
    SELECT 
      tc.telegram_id,
      tc.last_interaction_at
    FROM pix_users pu
    INNER JOIN telegram_contacts tc 
      ON pu.tg_user_id = tc.telegram_id 
      AND tc.bot_slug = $1
    WHERE tc.chat_state NOT IN ('blocked', 'deactivated')
  `;

  const params: any[] = [bot_slug];

  if (recencyDays && recencyDays > 0) {
    query += ` AND tc.last_interaction_at >= now() - interval '${recencyDays} days'`;
  }

  query += ` ORDER BY tc.last_interaction_at DESC NULLS LAST`;

  const { rows } = await pool.query(query, params);

  logger.info(
    { bot_slug, count: rows.length, recencyDays },
    '[SHOTS][AUDIENCE] pix_created audience selected'
  );

  return rows.map((row) => ({
    telegram_id: Number(row.telegram_id),
    last_interaction_at: row.last_interaction_at
      ? new Date(row.last_interaction_at)
      : null,
  }));
}

/**
 * Estimate audience size without fetching all members
 */
export async function estimateAudienceSize(params: AudienceParams): Promise<number> {
  const { bot_slug, target, recencyDays } = params;

  if (target === 'started') {
    let query = `
      SELECT COUNT(*) as count
      FROM telegram_contacts
      WHERE bot_slug = $1
        AND chat_state NOT IN ('blocked', 'deactivated')
    `;

    const queryParams: any[] = [bot_slug];

    if (recencyDays && recencyDays > 0) {
      query += ` AND last_interaction_at >= now() - interval '${recencyDays} days'`;
    }

    const { rows } = await pool.query(query, queryParams);
    return Number(rows[0].count ?? 0);
  } else if (target === 'pix_created') {
    let query = `
      WITH pix_users AS (
        SELECT DISTINCT tg_user_id
        FROM funnel_events
        WHERE bot_slug = $1
          AND event IN ('pix_created', 'checkout_pix_created')
          AND tg_user_id IS NOT NULL
        
        UNION
        
        SELECT DISTINCT telegram_id AS tg_user_id
        FROM payment_transactions
        WHERE bot_slug = $1
          AND status IN ('created', 'paid')
          AND telegram_id IS NOT NULL
      )
      SELECT COUNT(*) as count
      FROM pix_users pu
      INNER JOIN telegram_contacts tc 
        ON pu.tg_user_id = tc.telegram_id 
        AND tc.bot_slug = $1
      WHERE tc.chat_state NOT IN ('blocked', 'deactivated')
    `;

    const queryParams: any[] = [bot_slug];

    if (recencyDays && recencyDays > 0) {
      query += ` AND tc.last_interaction_at >= now() - interval '${recencyDays} days'`;
    }

    const { rows } = await pool.query(query, queryParams);
    return Number(rows[0].count ?? 0);
  }

  return 0;
}

import type { Logger } from '../../logger.js';
import { logger } from '../../logger.js';
import { getShotById, updateShotStatus } from '../../db/shots.js';
import { enqueueShotJob, insertShotJobsBulk, alreadyShotToUser } from '../../db/shotsQueue.js';
import { hasPaidTransactionForUser } from '../../db/payments.js';
import { funnelService } from '../FunnelService.js';
import { pool } from '../../db/pool.js';

export interface ScheduleShotParams {
  shot_id: number;
  logger?: Logger;
}

export interface QueueShotResult {
  queued: number;
  skipped: number;
  errors: number;
}

/**
 * Get target audience based on shot configuration
 */
async function getAudienceUserIds(
  bot_slug: string,
  audience: 'started' | 'pix',
  log: Logger
): Promise<number[]> {
  if (audience === 'started') {
    // Get users who started the bot (bot_start event)
    const { rows } = await pool.query<{ telegram_id: number }>(
      `SELECT DISTINCT tg_user_id AS telegram_id
         FROM funnel_events
        WHERE bot_id IN (SELECT id FROM bots WHERE slug = $1)
          AND event = 'bot_start'`,
      [bot_slug]
    );
    log.info({ audience, count: rows.length }, '[SHOTS][SCHEDULER] audience selected');
    return rows.map((r) => Number(r.telegram_id));
  }

  if (audience === 'pix') {
    // Get users who created a PIX (pix_created event)
    const { rows } = await pool.query<{ telegram_id: number }>(
      `SELECT DISTINCT tg_user_id AS telegram_id
         FROM funnel_events
        WHERE bot_id IN (SELECT id FROM bots WHERE slug = $1)
          AND event = 'pix_created'`,
      [bot_slug]
    );
    log.info({ audience, count: rows.length }, '[SHOTS][SCHEDULER] audience selected');
    return rows.map((r) => Number(r.telegram_id));
  }

  return [];
}

/**
 * Schedule a shot for delivery by populating the shots_queue
 */
export async function scheduleShotDelivery(params: ScheduleShotParams): Promise<QueueShotResult> {
  const log = (params.logger ?? logger).child({ shot_id: params.shot_id });

  const shot = await getShotById(params.shot_id);
  if (!shot) {
    log.error('[SHOTS][SCHEDULER] shot not found');
    throw new Error('Shot not found');
  }

  if (!shot.active) {
    log.warn('[SHOTS][SCHEDULER] shot is inactive');
    throw new Error('Shot is inactive');
  }

  const result: QueueShotResult = {
    queued: 0,
    skipped: 0,
    errors: 0,
  };

  // Get audience
  const userIds = await getAudienceUserIds(shot.bot_slug, shot.audience, log);
  log.info({ total_users: userIds.length }, '[SHOTS][SCHEDULER] audience loaded');

  if (userIds.length === 0) {
    log.warn('[SHOTS][SCHEDULER] no users in audience');
    return result;
  }

  // Determine delivery time
  let deliverAt: Date;
  if (shot.send_mode === 'now') {
    deliverAt = new Date();
  } else if (shot.send_mode === 'scheduled' && shot.scheduled_at) {
    deliverAt = shot.scheduled_at;
  } else {
    log.error('[SHOTS][SCHEDULER] scheduled mode requires scheduled_at');
    throw new Error('Scheduled mode requires scheduled_at date');
  }

  log.info({ deliver_at: deliverAt.toISOString(), send_mode: shot.send_mode }, '[SHOTS][SCHEDULER] delivery time set');

  // Enqueue jobs
  const jobsToInsert: Array<{
    bot_slug: string;
    shot_id: number;
    telegram_id: number;
    deliver_at: Date;
  }> = [];

  for (const telegramId of userIds) {
    // Skip if already sent
    const alreadySent = await alreadyShotToUser(shot.bot_slug, shot.id, telegramId);
    if (alreadySent) {
      log.debug({ telegram_id: telegramId }, '[SHOTS][SCHEDULER] already sent to user');
      result.skipped++;
      continue;
    }

    // Skip if user already paid
    const hasPaid = await hasPaidTransactionForUser(shot.bot_slug, telegramId);
    if (hasPaid) {
      log.debug({ telegram_id: telegramId }, '[SHOTS][SCHEDULER] user already paid');
      result.skipped++;
      continue;
    }

    jobsToInsert.push({
      bot_slug: shot.bot_slug,
      shot_id: shot.id,
      telegram_id: telegramId,
      deliver_at: deliverAt,
    });

    // Record funnel event: shot_scheduled
    const eventId = `sch:${shot.id}:${telegramId}`;
    await funnelService
      .createEvent({
        bot_id: null, // Will be resolved by service if needed
        tg_user_id: telegramId,
        event: 'shot_scheduled',
        event_id: eventId,
        price_cents: shot.price_cents ?? undefined,
        payload_id: String(shot.id),
        meta: {
          shot_id: shot.id,
          audience: shot.audience,
          send_mode: shot.send_mode,
        },
      })
      .catch((err) => {
        log.warn({ err, telegram_id: telegramId }, '[SHOTS][SCHEDULER] failed to record funnel event');
      });
  }

  // Bulk insert
  if (jobsToInsert.length > 0) {
    try {
      const inserted = await insertShotJobsBulk(jobsToInsert);
      result.queued = inserted;
      log.info({ queued: inserted }, '[SHOTS][SCHEDULER] jobs inserted');
    } catch (err) {
      log.error({ err }, '[SHOTS][SCHEDULER] failed to insert jobs');
      result.errors++;
      throw err;
    }
  }

  // Update shot status
  const newStatus = shot.send_mode === 'scheduled' ? 'scheduled' : 'queued';
  await updateShotStatus(shot.id, newStatus);
  log.info({ status: newStatus }, '[SHOTS][SCHEDULER] shot status updated');

  return result;
}

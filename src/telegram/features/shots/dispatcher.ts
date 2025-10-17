import type { PoolClient } from 'pg';
import { InlineKeyboard } from 'grammy';
import { logger } from '../../../logger.js';
import { pool } from '../../../db/pool.js';
import {
  listDueShotJobs,
  markShotJobAsSent,
  markShotJobAsSkipped,
  markShotJobAsError,
  incrementShotAttempt,
  alreadyShotToUser,
  type ShotQueueJob,
} from '../../../db/shotsQueue.js';
import { recordShotSent } from '../../../db/shotsSent.js';
import { getShotById } from '../../../db/shots.js';
import { hasPaidTransactionForUser } from '../../../db/payments.js';
import { getOrCreateBotBySlug } from '../../botFactory.js';
import { funnelService } from '../../../services/FunnelService.js';
import { getBotIdBySlug } from '../../../db/bots.js';

type ShotExtraPlan = { label: string; price_cents: number };

const LOCK_KEY = 4839202; // Different from downsells lock
const WORKER_INTERVAL_MS = 7000;
const MAX_JOBS_PER_TICK = 50;

function formatPriceBRL(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function buildShotKeyboard(
  shotId: number,
  options: { buttonText: string; mainPriceCents: number | null; extraPlans: ShotExtraPlan[] }
): InlineKeyboard | null {
  const buttons: { text: string; data: string }[] = [];
  const mainPrice =
    typeof options.mainPriceCents === 'number' &&
    Number.isFinite(options.mainPriceCents) &&
    options.mainPriceCents > 0
      ? Math.round(options.mainPriceCents)
      : null;

  // Main button
  if (mainPrice) {
    const priceBRL = formatPriceBRL(mainPrice);
    buttons.push({
      text: `${options.buttonText} — R$ ${priceBRL}`,
      data: `shot:${shotId}:main`,
    });
  }

  // Extra plans
  const extras = Array.isArray(options.extraPlans) ? options.extraPlans : [];
  let extraIndex = 0;
  for (const plan of extras) {
    const label = typeof plan?.label === 'string' ? plan.label.trim() : '';
    const cents = Number(plan?.price_cents);
    if (!label || !Number.isFinite(cents) || cents <= 0) {
      continue;
    }
    const priceBRL = formatPriceBRL(Math.round(cents));
    buttons.push({
      text: `${label} — R$ ${priceBRL}`,
      data: `shot:${shotId}:p${extraIndex}`,
    });
    extraIndex += 1;
  }

  if (buttons.length === 0) {
    return null;
  }

  const keyboard = new InlineKeyboard();
  buttons.forEach((btn, index) => {
    if (index > 0) {
      keyboard.row();
    }
    keyboard.text(btn.text, btn.data);
  });

  return keyboard;
}

async function acquireLock(): Promise<boolean> {
  const { rows } = await pool.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
  return Boolean(rows[0]?.locked);
}

async function releaseLock(): Promise<void> {
  await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch((err) => {
    logger.warn({ err }, '[SHOTS][WORKER] failed to release advisory lock');
  });
}

async function sendShotMediaIfAny(
  bot: any,
  chatId: number,
  mediaUrl: string | null | undefined,
  mediaType: string | null | undefined,
  jobLogger: any
): Promise<number | null> {
  if (!mediaUrl) return null;

  const mt = (mediaType ?? '').toLowerCase().trim();

  let ext = '';
  try {
    const u = new URL(mediaUrl);
    const p = u.pathname.toLowerCase();
    ext = p.includes('.') ? p.split('.').pop() || '' : '';
  } catch {
    // file_id case
  }

  const isVideo =
    mt.includes('video') || mt === 'mp4' || ext === 'mp4' || ext === 'mov' || ext === 'mkv' || ext === 'webm';
  const isAudio =
    mt.includes('audio') ||
    mt === 'mp3' ||
    mt === 'ogg' ||
    mt === 'oga' ||
    ext === 'mp3' ||
    ext === 'ogg' ||
    ext === 'oga' ||
    ext === 'm4a' ||
    ext === 'wav';
  const isGif = ext === 'gif' || mt.includes('gif');

  let kind: 'video' | 'audio' | 'photo' | 'animation' = 'photo';
  if (isGif) kind = 'animation';
  else if (isVideo) kind = 'video';
  else if (isAudio) kind = 'audio';

  jobLogger.info({ mediaType: mt || null, ext: ext || null, detected: kind, mediaUrl }, '[SHOTS][WORKER] media detect');

  try {
    let msg: any;

    if (kind === 'video') {
      msg = await bot.api.sendVideo(chatId, mediaUrl);
    } else if (kind === 'audio') {
      try {
        msg = await bot.api.sendAudio(chatId, mediaUrl);
      } catch (e) {
        jobLogger.warn({ e }, '[SHOTS][WORKER] sendAudio failed — trying sendVoice');
        msg = await bot.api.sendVoice(chatId, mediaUrl);
      }
    } else if (kind === 'animation') {
      msg = await bot.api.sendAnimation(chatId, mediaUrl);
    } else {
      msg = await bot.api.sendPhoto(chatId, mediaUrl);
    }

    const id = typeof msg?.message_id === 'number' ? msg.message_id : null;
    return id;
  } catch (err) {
    jobLogger.warn({ err, mediaUrl, mediaType: mt, ext, kind }, '[SHOTS][WORKER] failed to send shot media');
    return null;
  }
}

async function handleJob(job: ShotQueueJob, client: PoolClient): Promise<void> {
  const jobLogger = logger.child({
    bot_slug: job.bot_slug,
    shot_id: job.shot_id,
    telegram_id: job.telegram_id,
    job_id: job.id,
  });

  await incrementShotAttempt(job.id, client);

  try {
    // Check if already sent
    const alreadyRecorded = await alreadyShotToUser(job.bot_slug, job.shot_id, job.telegram_id, client);
    if (alreadyRecorded) {
      await markShotJobAsSkipped(job.id, 'already_sent', client);
      jobLogger.info('[SHOTS][WORKER] skipped because shot already sent');
      return;
    }

    // Check if user already paid
    const hasPaid = await hasPaidTransactionForUser(job.bot_slug, job.telegram_id);
    if (hasPaid) {
      await markShotJobAsSkipped(job.id, 'already_paid', client);
      jobLogger.info('[SHOTS][WORKER] skipped due to paid transaction');
      return;
    }

    const shot = await getShotById(job.shot_id);
    if (!shot || !shot.active) {
      await markShotJobAsSkipped(job.id, 'shot_inactive_or_invalid', client);
      jobLogger.info('[SHOTS][WORKER] skipped because shot inactive or invalid');
      return;
    }

    const extraPlans = Array.isArray(shot.extra_plans) ? shot.extra_plans : [];
    const mainPriceCents =
      typeof shot.price_cents === 'number' && shot.price_cents > 0 ? shot.price_cents : null;
    const hasValidPrice = mainPriceCents !== null && mainPriceCents > 0;
    const hasExtraPlanOption = extraPlans.some(
      (plan) =>
        typeof plan?.price_cents === 'number' &&
        plan.price_cents > 0 &&
        typeof plan.label === 'string' &&
        plan.label.trim().length > 0
    );

    if (!hasValidPrice && !hasExtraPlanOption) {
      await markShotJobAsSkipped(job.id, 'shot_price_missing', client);
      jobLogger.info('[SHOTS][WORKER] skipped due to missing price');
      return;
    }

    const botId = await getBotIdBySlug(job.bot_slug);
    if (!botId) {
      await markShotJobAsError(job.id, 'bot_not_found', client);
      jobLogger.error('[SHOTS][WORKER] bot not found');
      return;
    }

    const bot = await getOrCreateBotBySlug(job.bot_slug);

    // Send media if exists
    const mediaMsgId = await sendShotMediaIfAny(
      bot,
      job.telegram_id,
      shot.media_url,
      shot.media_type,
      jobLogger
    );

    // Send copy if exists
    if (shot.copy && shot.copy.trim().length > 0) {
      try {
        await bot.api.sendMessage(job.telegram_id, shot.copy, { parse_mode: 'HTML' });
      } catch (copyErr) {
        jobLogger.warn({ err: copyErr }, '[SHOTS][WORKER] failed to send shot copy');
      }
    }

    // Build and send keyboard
    const defaultIntro = shot.intro_text?.trim() || 'Clique abaixo para continuar:';
    const keyboard = buildShotKeyboard(shot.id, {
      buttonText: shot.button_text,
      mainPriceCents,
      extraPlans,
    });

    if (!keyboard) {
      await markShotJobAsSkipped(job.id, 'no_valid_buttons', client);
      jobLogger.warn('[SHOTS][WORKER] skipped: no valid buttons to display');
      return;
    }

    const sent = await bot.api.sendMessage(job.telegram_id, defaultIntro, {
      reply_markup: keyboard,
    });
    const sentMessageId = sent?.message_id !== undefined ? String(sent.message_id) : null;

    // Record sent
    await recordShotSent(
      {
        bot_slug: job.bot_slug,
        shot_id: job.shot_id,
        telegram_id: job.telegram_id,
        message_id: sentMessageId,
        price_cents: mainPriceCents,
      },
      client
    );

    await markShotJobAsSent(job.id, sentMessageId, client);

    // Funnel event: shot_sent
    const eventId = `sent:${shot.id}:${job.telegram_id}`;
    await funnelService
      .createEvent({
        bot_id: botId,
        tg_user_id: job.telegram_id,
        event: 'shot_sent',
        event_id: eventId,
        price_cents: mainPriceCents ?? undefined,
        payload_id: String(shot.id),
        meta: {
          shot_id: shot.id,
          job_id: job.id,
        },
      })
      .catch((err) => {
        jobLogger.warn({ err }, '[SHOTS][WORKER] failed to record funnel event');
      });

    jobLogger.info({ shot_id: shot.id }, '[SHOTS][WORKER] sent shot successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
    await markShotJobAsError(job.id, message, client);
    jobLogger.error({ err }, '[SHOTS][WORKER] job failed');
  }
}

export function startShotsWorker(_app?: unknown): void {
  const workerLogger = logger.child({ worker: 'shots' });

  const tick = async () => {
    console.info('[SHOTS][WORKER][TICK]');
    const locked = await acquireLock();
    if (!locked) {
      return;
    }

    try {
      while (true) {
        const picked = await listDueShotJobs(MAX_JOBS_PER_TICK);
        if (!picked) {
          console.info('[SHOTS][PICK]', { due_found: 0, status: 'scheduled' });
          break;
        }

        const { client, jobs } = picked;
        console.info('[SHOTS][PICK]', { due_found: jobs.length, status: 'scheduled' });
        try {
          for (const job of jobs) {
            await handleJob(job, client);
          }
          await client.query('COMMIT');
        } catch (batchErr) {
          await client.query('ROLLBACK').catch(() => undefined);
          workerLogger.error({ err: batchErr }, '[SHOTS][WORKER] batch failed, rolled back');
        } finally {
          client.release();
        }

        if (jobs.length < MAX_JOBS_PER_TICK) {
          break;
        }
      }
    } catch (err) {
      workerLogger.error({ err }, '[SHOTS][WORKER] tick failed');
    } finally {
      await releaseLock();
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, WORKER_INTERVAL_MS);
}

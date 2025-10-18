import { logger } from '../../logger.js';
import { pool } from '../../db/pool.js';
import { getOrCreateBotBySlug } from '../../telegram/botFactory.js';
import {
  pickDueShotQueueJobs,
  markShotQueueSuccess,
  markShotQueueError,
  markShotQueueProcessing,
  scheduleShotQueueRetry,
  resetStuckShotQueueJobs,
  type ShotQueueJob,
} from '../../db/shotsQueue.js';
import { recordShotSent } from '../../db/shotsSent.js';
import { ShotsMessageBuilder } from './ShotsMessageBuilder.js';
import { getShotWithPlans } from '../../repositories/ShotsRepo.js';
import { shotsService } from '../ShotsService.js';
import { FunnelEventsRepo } from '../../repositories/FunnelEventsRepo.js';
import { metrics } from '../../metrics.js';
import type { ShotRow } from '../../repositories/ShotsRepo.js';
import type { PoolClient } from 'pg';
import type { MediaType } from '../../db/shotsQueue.js';
import type { ShotEventTarget } from '../../repositories/FunnelEventsRepo.js';

export const __dependencies = {
  getShotWithPlans,
  getOrCreateBotBySlug,
  markShotQueueSuccess,
  markShotQueueError,
  recordShotSent,
  markShotQueueProcessing,
  scheduleShotQueueRetry,
  insertShotSent: FunnelEventsRepo.insertShotSent,
  insertShotError: FunnelEventsRepo.insertShotError,
  enqueueShotRecipients: shotsService.enqueueShotRecipients.bind(shotsService),
};

const LOCK_KEY = 4839202; // Keep separate from downsells worker
const WORKER_INTERVAL_MS = 7000;
const DEFAULT_MAX_JOBS_PER_TICK = 25;
const MAX_JOBS_PER_TICK = (() => {
  const raw = process.env.SHOTS_WORKER_BATCH_SIZE;
  if (!raw) {
    return DEFAULT_MAX_JOBS_PER_TICK;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_JOBS_PER_TICK;
})();
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_JOB_ATTEMPTS = (() => {
  const raw = process.env.SHOTS_WORKER_MAX_ATTEMPTS;
  if (!raw) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ATTEMPTS;
})();
const DEFAULT_RETRY_DELAYS_SECONDS = [30, 300];
const RETRY_DELAYS_SECONDS = (() => {
  const raw = process.env.SHOTS_WORKER_RETRY_DELAYS;
  if (!raw) {
    return DEFAULT_RETRY_DELAYS_SECONDS;
  }
  const parsed = raw
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  return parsed.length > 0 ? parsed : DEFAULT_RETRY_DELAYS_SECONDS;
})();

async function acquireLock(): Promise<boolean> {
  const { rows } = await pool.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
  return Boolean(rows[0]?.locked);
}

async function releaseLock(): Promise<void> {
  await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch((err) => {
    logger.warn({ err }, '[SHOTS][WORKER] failed to release advisory lock');
  });
}

function normalizeMediaType(value: string | null | undefined): MediaType {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'photo' || normalized === 'video' || normalized === 'audio' || normalized === 'document') {
    return normalized as MediaType;
  }
  return 'none';
}

function computeNextRetry(attempts: number): Date | null {
  if (!Number.isFinite(attempts) || attempts <= 0) {
    return null;
  }

  const index = attempts - 1;
  const delaySeconds = RETRY_DELAYS_SECONDS[index];
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    return null;
  }

  return new Date(Date.now() + delaySeconds * 1000);
}

function createCorrelation(job: ShotQueueJob): string {
  const shotPart = job.shot_id != null ? job.shot_id : 'null';
  const telegramPart = job.telegram_id != null ? job.telegram_id : 'null';
  return `q:${job.id}|sh:${shotPart}|tg:${telegramPart}`;
}

function normalizeTelegramId(value: number | null): bigint {
  if (value === null || value === undefined) {
    throw new Error('Queue item missing telegram_id');
  }

  try {
    return BigInt(value);
  } catch {
    return BigInt(Math.trunc(value));
  }
}

function resolveShotTarget(shot: ShotRow | null, job: ShotQueueJob): ShotEventTarget {
  const shotTarget = shot?.target;
  if (shotTarget === 'all_started' || shotTarget === 'pix_generated') {
    return shotTarget;
  }

  const queueTarget = job.target;
  if (queueTarget === 'pix_created') {
    return 'pix_generated';
  }

  return 'all_started';
}

async function processShotQueueJob(job: ShotQueueJob, client: PoolClient): Promise<void> {
  const corr = createCorrelation(job);
  const jobLogger = logger.child({
    scope: 'shots_worker',
    queue_id: job.id,
    shot_id: job.shot_id,
    bot_slug: job.bot_slug,
    telegram_id: job.telegram_id,
    corr,
  });

  const baseAttempt = Number.isFinite(job.attempts)
    ? Number(job.attempts)
    : Number.isFinite(job.attempt_count)
    ? Number(job.attempt_count)
    : 0;
  const nextAttempt = baseAttempt + 1;

  jobLogger.info(`[SHOTS][WORKER][DEQUEUE] id=${job.id} attempt=${nextAttempt} corr="${corr}"`);

  if (job.shot_id == null || job.telegram_id == null) {
    await __dependencies.markShotQueueError(job.id, 'Queue item missing shot_id or telegram_id', client);
    jobLogger.error(`[SHOTS][WORKER] invalid queue item payload corr="${corr}"`);
    metrics.count('shots.worker.error', 1);
    return;
  }

  const telegramId = normalizeTelegramId(job.telegram_id);
  const telegramIdString = telegramId.toString();
  let eventTarget: ShotEventTarget = resolveShotTarget(null, job);

  const processingJob = await __dependencies.markShotQueueProcessing(job.id, client);
  if (!processingJob) {
    jobLogger.warn(`[SHOTS][WORKER] failed to mark job as processing corr="${corr}"`);
    return;
  }
  const attemptNumber =
    (Number.isFinite(processingJob.attempts)
      ? Number(processingJob.attempts)
      : Number.isFinite(job.attempts)
      ? Number(job.attempts)
      : nextAttempt) || nextAttempt;

  let shotRecord: ShotRow | null = null;

  try {
    const { shot, plans } = await __dependencies.getShotWithPlans(job.shot_id);
    shotRecord = shot;
    eventTarget = resolveShotTarget(shot, job);
    const bot = await __dependencies.getOrCreateBotBySlug(job.bot_slug);
    const telegram = bot.api ?? bot.telegram ?? bot;

    const normalizedShot: ShotRow = {
      ...shot,
      media_type: normalizeMediaType(shot.media_type) as ShotRow['media_type'],
    };

    let introResult: { mediaMessageId?: number; textMessageIds: number[] } = {
      mediaMessageId: undefined,
      textMessageIds: [],
    };
    let plansResult: { planMessageId?: number } = {};
    const sendStartedAt = Date.now();
    try {
      introResult = await ShotsMessageBuilder.sendShotIntro(telegram, job.telegram_id, normalizedShot, {
        corr,
      });

      plansResult = await ShotsMessageBuilder.sendShotPlans(
        telegram,
        job.telegram_id,
        normalizedShot,
        plans,
        { corr }
      );
    } finally {
      metrics.timing('shots.worker.send_ms', Date.now() - sendStartedAt);
    }

    const introDelivered = Boolean(introResult.mediaMessageId) || introResult.textMessageIds.length > 0;
    const plansDelivered = plansResult.planMessageId !== undefined;
    const sendStatus = introDelivered || plansDelivered ? 'sent' : 'skipped';

    try {
      await __dependencies.recordShotSent(
        {
          shot_id: shot.id,
          bot_slug: shot.bot_slug,
          telegram_id: job.telegram_id,
          status: sendStatus,
          error: null,
        },
        client
      );
    } catch (recordErr) {
      jobLogger.warn({ err: recordErr }, `[SHOTS][WORKER] failed to record shot result corr="${corr}"`);
    }

    const shotSentEventId = `shs:${shot.id}:${telegramIdString}`;
    try {
      await __dependencies.insertShotSent({
        shotId: shot.id,
        botSlug: shot.bot_slug,
        telegramId,
        target: eventTarget,
      });
      jobLogger.info(
        `[SHOTS][EVENT] name=shot_sent event_id=${shotSentEventId} shot=${shot.id} tg=${telegramIdString} corr="${corr}"`
      );
    } catch (eventErr) {
      jobLogger.warn(
        { err: eventErr },
        `[SHOTS][EVENT] failed name=shot_sent event_id=${shotSentEventId} corr="${corr}"`
      );
    }

    await __dependencies.markShotQueueSuccess(job.id, client);
    metrics.count('shots.worker.success', 1);

    jobLogger.info(
      `[SHOTS][QUEUE][DONE] id=${job.id} status=success attempts=${attemptNumber} corr="${corr}"`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? 'unknown error');

    try {
      await __dependencies.recordShotSent(
        {
          shot_id: shotRecord?.id ?? job.shot_id,
          bot_slug: shotRecord?.bot_slug ?? job.bot_slug,
          telegram_id: job.telegram_id,
          status: 'error',
          error: message,
        },
        client
      );
    } catch (recordErr) {
      logger.warn(
        { err: recordErr, queue_id: job.id, corr },
        `[SHOTS][WORKER] failed to record error result corr="${corr}"`
      );
    }

    const shotIdForEvent = shotRecord?.id ?? job.shot_id ?? 0;
    const botSlugForEvent = shotRecord?.bot_slug ?? job.bot_slug;
    eventTarget = shotRecord ? resolveShotTarget(shotRecord, job) : eventTarget;

    const shotErrorEventId = `she:${shotIdForEvent}:${telegramIdString}:${attemptNumber}`;
    try {
      await __dependencies.insertShotError({
        shotId: shotIdForEvent,
        botSlug: botSlugForEvent,
        telegramId,
        target: eventTarget,
        attempt: attemptNumber,
        errorMessage: message,
      });
      jobLogger.info(
        `[SHOTS][EVENT] name=shot_error event_id=${shotErrorEventId} shot=${shotIdForEvent} tg=${telegramIdString} corr="${corr}"`
      );
    } catch (eventErr) {
      jobLogger.warn(
        { err: eventErr },
        `[SHOTS][EVENT] failed name=shot_error event_id=${shotErrorEventId} corr="${corr}"`
      );
    }

    const shouldRetry = attemptNumber < MAX_JOB_ATTEMPTS;
    if (shouldRetry) {
      const nextRetryAt = computeNextRetry(attemptNumber);
      if (nextRetryAt) {
        await __dependencies.scheduleShotQueueRetry(job.id, message, nextRetryAt, client);
        jobLogger.warn(
          { err, attempt: attemptNumber, next_retry_at: nextRetryAt.toISOString() },
          `[SHOTS][WORKER] job scheduled for retry corr="${corr}"`
        );
      } else {
        await __dependencies.markShotQueueError(job.id, message, client);
        jobLogger.error(
          { err, attempt: attemptNumber },
          `[SHOTS][WORKER] job failed without retry window corr="${corr}"`
        );
      }
    } else {
      await __dependencies.markShotQueueError(job.id, message, client);
      jobLogger.error({ err, attempt: attemptNumber }, `[SHOTS][WORKER] job reached max attempts corr="${corr}"`);
    }

    metrics.count('shots.worker.error', 1);

    logger.error(
      { shot_id: job.shot_id, telegram_id: job.telegram_id, message, attempt: attemptNumber, corr },
      `[SHOTS][ERROR] failed to dispatch shot corr="${corr}"`
    );

    jobLogger.info(
      `[SHOTS][QUEUE][DONE] id=${job.id} status=error attempts=${attemptNumber} corr="${corr}"`
    );
  }
}

export const __private__ = { processShotQueueJob, __dependencies };

export function startShotsWorker(): void {
  const workerLogger = logger.child({ worker: 'shots' });

  const tick = async () => {
    workerLogger.info('[SHOTS][WORKER][TICK]');

    const resetCount = await resetStuckShotQueueJobs(30, MAX_JOB_ATTEMPTS);
    if (resetCount > 0) {
      workerLogger.info({ reset: resetCount }, '[SHOTS][WORKER] reset stuck jobs');
    }

    const locked = await acquireLock();
    if (!locked) {
      workerLogger.debug('[SHOTS][WORKER] could not acquire lock, skipping tick');
      return;
    }

    try {
      while (true) {
        const picked = await pickDueShotQueueJobs(MAX_JOBS_PER_TICK);
        if (!picked) {
          workerLogger.debug('[SHOTS][WORKER] no pending jobs');
          break;
        }

        const { client, jobs } = picked;
        metrics.count('shots.worker.fetched', jobs.length);
        workerLogger.info({ picked: jobs.length }, '[SHOTS][WORKER] jobs selected');

        try {
          const uniqueShotIds = Array.from(
            new Set(
              jobs
                .map((job) => job.shot_id)
                .filter((value): value is number => Number.isInteger(value) && value > 0)
            )
          );

          for (const shotId of uniqueShotIds) {
            try {
              const stats = await __dependencies.enqueueShotRecipients(shotId);
              workerLogger.info(
                { shot_id: shotId, ...stats },
                '[SHOTS][WORKER][QUEUE]'
              );
            } catch (enqueueErr) {
              workerLogger.error(
                { err: enqueueErr, shot_id: shotId },
                '[SHOTS][WORKER][QUEUE] failed to enqueue recipients'
              );
            }
          }

          for (const job of jobs) {
            await processShotQueueJob(job, client);
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

  workerLogger.info('[SHOTS][WORKER] started');
}

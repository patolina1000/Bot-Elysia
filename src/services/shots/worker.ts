import { logger } from '../../logger.js';
import { pool } from '../../db/pool.js';
import { getOrCreateBotBySlug } from '../../telegram/botFactory.js';
import {
  pickDueShotQueueJobs,
  markShotQueueSuccess,
  markShotQueueError,
  resetStuckShotQueueJobs,
  type ShotQueueJob,
} from '../../db/shotsQueue.js';
import { recordShotSent } from '../../db/shotsSent.js';
import { ShotsMessageBuilder } from './ShotsMessageBuilder.js';
import { getShotWithPlans } from '../../repositories/ShotsRepo.js';
import type { ShotRecord } from '../../repositories/ShotsRepo.js';
import type { PoolClient } from 'pg';
import type { MediaType } from '../../db/shotsQueue.js';

export const __dependencies = {
  getShotWithPlans,
  getOrCreateBotBySlug,
  markShotQueueSuccess,
  markShotQueueError,
  recordShotSent,
};

const LOCK_KEY = 4839202; // Keep separate from downsells worker
const WORKER_INTERVAL_MS = 7000;
const MAX_JOBS_PER_TICK = 25;

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

async function processShotQueueJob(job: ShotQueueJob, client: PoolClient): Promise<void> {
  const jobLogger = logger.child({
    scope: 'shots_worker',
    queue_id: job.id,
    shot_id: job.shot_id,
    bot_slug: job.bot_slug,
    telegram_id: job.telegram_id,
  });

  if (job.shot_id == null || job.telegram_id == null) {
    await __dependencies.markShotQueueError(job.id, 'Queue item missing shot_id or telegram_id', client);
    jobLogger.error('[SHOTS][WORKER] invalid queue item payload');
    return;
  }

  let shotRecord: ShotRecord | null = null;

  try {
    const { shot, plans } = await __dependencies.getShotWithPlans(job.shot_id);
    shotRecord = shot;
    const bot = await __dependencies.getOrCreateBotBySlug(job.bot_slug);

    const introResult = await ShotsMessageBuilder.sendShotIntro(bot, job.telegram_id, {
      bot_slug: shot.bot_slug,
      copy: shot.copy ?? '',
      media_type: normalizeMediaType(shot.media_type),
      media_url: shot.media_url,
    });

    const plansResult = await ShotsMessageBuilder.sendShotPlans(bot, job.telegram_id, shot, plans);

    const introCompleted = introResult.completed !== false;
    const plansCompleted = plansResult.completed !== false;
    const sendStatus = introCompleted && plansCompleted ? 'sent' : 'skipped';

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
      jobLogger.warn({ err: recordErr }, '[SHOTS][WORKER] failed to record shot result');
    }

    await __dependencies.markShotQueueSuccess(job.id, client);

    jobLogger.info(
      {
        send_status: sendStatus,
        intro_completed: introCompleted,
        plans_completed: plansCompleted,
      },
      '[SHOTS][SUCCESS]'
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
      logger.warn({ err: recordErr, queue_id: job.id }, '[SHOTS][WORKER] failed to record error result');
    }

    await __dependencies.markShotQueueError(job.id, message, client);
    logger.error(
      { shot_id: job.shot_id, telegram_id: job.telegram_id, message },
      '[SHOTS][ERROR] failed to dispatch shot'
    );
    jobLogger.error({ err }, '[SHOTS][WORKER] job failed');
  }
}

export const __private__ = { processShotQueueJob, __dependencies };

export function startShotsWorker(): void {
  const workerLogger = logger.child({ worker: 'shots' });

  const tick = async () => {
    workerLogger.info('[SHOTS][WORKER][TICK]');

    const resetCount = await resetStuckShotQueueJobs(30);
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
        workerLogger.info({ picked: jobs.length }, '[SHOTS][WORKER] jobs selected');

        try {
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

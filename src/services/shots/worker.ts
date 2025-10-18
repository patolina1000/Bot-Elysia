import { logger } from '../../logger.js';
import { pool } from '../../db/pool.js';
import { getOrCreateBotBySlug } from '../../telegram/botFactory.js';
import { sendSafe } from '../../utils/telegramErrorHandler.js';
import {
  pickPendingShot,
  markShotAsSent,
  markShotAsError,
  resetStuckJobs,
  type ShotQueueJob,
} from '../../db/shotsQueue.js';
import { recordShotSent, bulkRecordShotsSent, type RecordShotSentParams } from '../../db/shotsSent.js';
import { selectAudience } from './audienceSelector.js';
import { updateTelegramContactChatState } from '../../services/TelegramContactsService';
import { shotsService } from '../ShotsService.js';
import type { PoolClient } from 'pg';
import { ShotsMessageBuilder } from './ShotsMessageBuilder.js';
import { getShotWithPlans, type ShotWithPlansResult } from '../../repositories/ShotsRepo.js';

const LOCK_KEY = 4839202; // Different from downsells worker
const WORKER_INTERVAL_MS = 10000; // Check every 10 seconds
const BATCH_SIZE = 50; // Send to 50 users at a time
const RATE_LIMIT_PER_SECOND = 25; // Max 25 requests/second to Telegram
const CONCURRENT_SENDS = 10; // Send to 10 users concurrently
const RETRY_AFTER_429_MS = 30000; // Wait 30s after 429

interface SendResult {
  telegram_id: number;
  status: 'sent' | 'skipped' | 'error';
  error?: string;
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

type ShotPlansContext = ShotWithPlansResult | null;

async function sendMessageByType(
  bot: any,
  telegramId: number,
  job: ShotQueueJob,
  botSlug: string,
  plansContext: ShotPlansContext
): Promise<{ success: boolean; error?: string }> {
  try {
    const introResult = await ShotsMessageBuilder.sendShotIntro(bot, telegramId, {
      bot_slug: job.bot_slug,
      copy: job.copy,
      media_type: job.media_type,
      media_url: job.media_url,
    });

    const hasPlans = plansContext && plansContext.plans.length > 0;

    if (hasPlans) {
      const planResult = await ShotsMessageBuilder.sendShotPlans(
        bot,
        telegramId,
        plansContext.shot,
        plansContext.plans
      );

      if (!planResult.completed) {
        logger.warn(
          { bot_slug: botSlug, telegram_id: telegramId },
          '[SHOTS][WORKER] failed to send some plan messages'
        );
      }
    }

    return { success: true };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    
    // Check for specific Telegram errors
    if (errorMsg.includes('403') || errorMsg.includes('blocked')) {
      return { success: false, error: 'blocked' };
    }
    if (errorMsg.includes('deactivated')) {
      return { success: false, error: 'deactivated' };
    }
    if (errorMsg.includes('429')) {
      return { success: false, error: 'rate_limit' };
    }

    return { success: false, error: errorMsg };
  }
}

async function processBatch(
  bot: any,
  job: ShotQueueJob,
  audienceSlice: { telegram_id: number }[],
  plansContext: ShotPlansContext
): Promise<SendResult[]> {
  const results: SendResult[] = [];
  const jobLogger = logger.child({
    shot_id: job.id,
    bot_slug: job.bot_slug,
    batch_size: audienceSlice.length,
  });

  // Process in smaller chunks with concurrency control
  for (let i = 0; i < audienceSlice.length; i += CONCURRENT_SENDS) {
    const chunk = audienceSlice.slice(i, i + CONCURRENT_SENDS);
    
    // Send concurrently within chunk
    const chunkResults = await Promise.all(
      chunk.map(async (member) => {
        const result = await sendMessageByType(
          bot,
          member.telegram_id,
          job,
          job.bot_slug,
          plansContext
        );
        
        if (!result.success) {
          if (result.error === 'blocked') {
            // Update telegram_contacts to mark as blocked
            await updateTelegramContactChatState(
              job.bot_slug,
              member.telegram_id,
              'blocked'
            ).catch((err: unknown) => {
              logger.warn(
                { err, telegram_id: member.telegram_id },
                '[SHOTS][WORKER] failed to update chat_state to blocked'
              );
            });
            
            return {
              telegram_id: member.telegram_id,
              status: 'skipped' as const,
              error: 'User blocked the bot',
            };
          } else if (result.error === 'deactivated') {
            // Update telegram_contacts to mark as deactivated
            await updateTelegramContactChatState(
              job.bot_slug,
              member.telegram_id,
              'deactivated'
            ).catch((err: unknown) => {
              logger.warn(
                { err, telegram_id: member.telegram_id },
                '[SHOTS][WORKER] failed to update chat_state to deactivated'
              );
            });
            
            return {
              telegram_id: member.telegram_id,
              status: 'skipped' as const,
              error: 'User deactivated',
            };
          } else if (result.error === 'rate_limit') {
            jobLogger.warn('[SHOTS][WORKER] rate limit hit, waiting...');
            await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_429_MS));
            
            // Retry once after waiting
            const retryResult = await sendMessageByType(bot, member.telegram_id, job, job.bot_slug);
            if (retryResult.success) {
              return {
                telegram_id: member.telegram_id,
                status: 'sent' as const,
              };
            }
            
            return {
              telegram_id: member.telegram_id,
              status: 'error' as const,
              error: 'Rate limit exceeded',
            };
          }
          
          return {
            telegram_id: member.telegram_id,
            status: 'error' as const,
            error: result.error,
          };
        }

        return {
          telegram_id: member.telegram_id,
          status: 'sent' as const,
        };
      })
    );

    results.push(...chunkResults);

    // Rate limiting: wait between chunks to respect ~25 req/s
    if (i + CONCURRENT_SENDS < audienceSlice.length) {
      const delayMs = (CONCURRENT_SENDS / RATE_LIMIT_PER_SECOND) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

async function handleJob(job: ShotQueueJob, client: PoolClient): Promise<void> {
  const jobLogger = logger.child({
    shot_id: job.id,
    bot_slug: job.bot_slug,
    target: job.target,
  });

  jobLogger.info('[SHOTS][WORKER] processing job');

  try {
    // Get bot instance
    const bot = await getOrCreateBotBySlug(job.bot_slug);

    let plansContext: ShotPlansContext = null;
    try {
      plansContext = await getShotWithPlans(job.id);
    } catch (plansErr) {
      jobLogger.warn({ err: plansErr }, '[SHOTS][PLANS] failed to load plans');
    }

    if (!plansContext || plansContext.plans.length === 0) {
      jobLogger.info('[SHOTS][PLANS] none');
    }

    const enqueueResult = await shotsService.enqueueShotRecipients(job.id);
    jobLogger.info(
      {
        candidates: enqueueResult.candidates,
        inserted: enqueueResult.inserted,
        duplicates: enqueueResult.duplicates,
      },
      '[SHOTS][ENQUEUE] recipients enqueued'
    );

    // Select audience
    const audience = await selectAudience({
      bot_slug: job.bot_slug,
      target: job.target,
    });

    jobLogger.info(
      { audience_size: audience.length },
      '[SHOTS][WORKER] audience selected'
    );

    if (audience.length === 0) {
      await markShotAsSent(job.id, client);
      jobLogger.info('[SHOTS][WORKER] no audience, marking as sent');
      return;
    }

    // Process audience in batches
    let totalSent = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (let i = 0; i < audience.length; i += BATCH_SIZE) {
      const batch = audience.slice(i, i + BATCH_SIZE);
      
      jobLogger.info(
        {
          batch_index: Math.floor(i / BATCH_SIZE) + 1,
          batch_size: batch.length,
          progress: `${i + batch.length}/${audience.length}`,
        },
        '[SHOTS][WORKER] processing batch'
      );

      const results = await processBatch(bot, job, batch, plansContext);

      // Aggregate results
      const sent = results.filter((r) => r.status === 'sent').length;
      const skipped = results.filter((r) => r.status === 'skipped').length;
      const errors = results.filter((r) => r.status === 'error').length;

      totalSent += sent;
      totalSkipped += skipped;
      totalErrors += errors;

      // Record to shots_sent table
      const records: RecordShotSentParams[] = results.map((r) => ({
        shot_id: job.id,
        bot_slug: job.bot_slug,
        telegram_id: r.telegram_id,
        status: r.status,
        error: r.error,
      }));

      await bulkRecordShotsSent(records, client);

      jobLogger.info(
        { sent, skipped, errors, total_sent: totalSent, total_skipped: totalSkipped, total_errors: totalErrors },
        '[SHOTS][WORKER] batch completed'
      );
    }

    // Mark job as sent
    await markShotAsSent(job.id, client);

    jobLogger.info(
      {
        total_sent: totalSent,
        total_skipped: totalSkipped,
        total_errors: totalErrors,
        total_audience: audience.length,
      },
      '[SHOTS][WORKER] job completed successfully'
    );
  } catch (err) {
    // DO NOT call markShotAsError here with the aborted transaction client
    // It will be handled in the outer catch block after ROLLBACK
    jobLogger.error({ err }, '[SHOTS][WORKER] job failed');
    throw err; // Re-throw to trigger ROLLBACK in outer handler
  }
}

export function startShotsWorker(): void {
  const workerLogger = logger.child({ worker: 'shots' });

  const tick = async () => {
    workerLogger.info('[SHOTS][WORKER][TICK]');
    
    // Reset stuck jobs first
    const resetCount = await resetStuckJobs(30); // 30 minutes timeout
    if (resetCount > 0) {
      workerLogger.info({ count: resetCount }, '[SHOTS][WORKER] reset stuck jobs');
    }

    const locked = await acquireLock();
    if (!locked) {
      workerLogger.debug('[SHOTS][WORKER] could not acquire lock, skipping tick');
      return;
    }

    try {
      // Process one job at a time (since each job processes entire audience)
      const picked = await pickPendingShot();
      if (!picked) {
        workerLogger.info('[SHOTS][WORKER] no pending jobs');
        return;
      }

      const { client, job } = picked;
      
      try {
        await handleJob(job, client);
        await client.query('COMMIT');
      } catch (batchErr) {
        // Rollback the aborted transaction
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
        
        // Now mark the shot as error using a separate connection (NOT the aborted transaction)
        const errorMessage = batchErr instanceof Error ? batchErr.message : String(batchErr ?? 'unknown error');
        try {
          await markShotAsError(job.id, errorMessage); // No client param = uses pool directly
          workerLogger.error({ err: batchErr, shot_id: job.id }, '[SHOTS][WORKER] batch failed, marked as error');
        } catch (markErr) {
          workerLogger.error(
            { err: markErr, original_error: batchErr, shot_id: job.id },
            '[SHOTS][WORKER] failed to mark shot as error after batch failure'
          );
        }
        return; // Don't re-release client in finally block
      }
      
      client.release();
    } catch (err) {
      workerLogger.error({ err }, '[SHOTS][WORKER] tick failed');
    } finally {
      await releaseLock();
    }
  };

  // Run immediately
  void tick();

  // Run periodically
  setInterval(() => {
    void tick();
  }, WORKER_INTERVAL_MS);

  workerLogger.info('[SHOTS][WORKER] started');
}

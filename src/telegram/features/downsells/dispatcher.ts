import type { PoolClient } from 'pg';
import { logger } from '../../../logger.js';
import { pool } from '../../../db/pool.js';
import {
  pickDueJobs,
  markJobAsSent,
  markJobAsSkipped,
  markJobAsError,
  incrementAttempt,
  alreadySent,
  type DownsellQueueJob,
} from '../../../db/downsellsQueue.js';
import { recordSent } from '../../../db/downsellsSent.js';
import { getDownsellById } from '../../../db/downsells.js';
import { hasPaidTransactionForUser } from '../../../db/payments.js';
import { createPixForCustomPrice } from '../payments/sendPixMessage.js';
import { sendPixByChatId } from '../payments/sendPixByChatId.js';
import { generatePixTraceId } from '../../../utils/pixLogging.js';
import { getOrCreateBotBySlug } from '../../botFactory.js';
import { funnelService } from '../../../services/FunnelService.js';
import { getBotIdBySlug } from '../../../db/bots.js';
import { getBotSettings } from '../../../db/botSettings.js';

const LOCK_KEY = 4839201;
const WORKER_INTERVAL_MS = 7000;
const MAX_JOBS_PER_TICK = 50;

async function acquireLock(): Promise<boolean> {
  const { rows } = await pool.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
  return Boolean(rows[0]?.locked);
}

async function releaseLock(): Promise<void> {
  await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch((err) => {
    logger.warn({ err }, '[DOWNSELL][WORKER] failed to release advisory lock');
  });
}

async function handleJob(job: DownsellQueueJob, client: PoolClient): Promise<void> {
  const jobLogger = logger.child({
    bot_slug: job.bot_slug,
    downsell_id: job.downsell_id,
    telegram_id: job.telegram_id,
    job_id: job.id,
  });

  await incrementAttempt(job.id, client);

  try {
    const alreadyRecorded = await alreadySent(job.bot_slug, job.downsell_id, job.telegram_id, client);
    if (alreadyRecorded) {
      await markJobAsSkipped(job.id, 'already_sent', client);
      jobLogger.info('[DOWNSELL][WORKER] skipped because downsell already sent');
      return;
    }

    const hasPaid = await hasPaidTransactionForUser(job.bot_slug, job.telegram_id);
    if (hasPaid) {
      await markJobAsSkipped(job.id, 'paid_transaction', client);
      jobLogger.info('[DOWNSELL][WORKER] skipped due to paid transaction');
      return;
    }

    const downsell = await getDownsellById(job.downsell_id);
    if (!downsell || !downsell.active || !Number.isFinite(downsell.price_cents) || downsell.price_cents <= 0) {
      await markJobAsSkipped(job.id, 'downsell_inactive_or_invalid', client);
      jobLogger.info('[DOWNSELL][WORKER] skipped because downsell inactive or invalid');
      return;
    }

    const botId = await getBotIdBySlug(job.bot_slug);
    if (!botId) {
      await markJobAsError(job.id, 'bot_not_found', client);
      jobLogger.error('[DOWNSELL][WORKER] bot not found');
      return;
    }

    const bot = await getOrCreateBotBySlug(job.bot_slug);
    const settings = await getBotSettings(job.bot_slug);

    if (downsell.copy && downsell.copy.trim().length > 0) {
      try {
        await bot.api.sendMessage(job.telegram_id, downsell.copy, { parse_mode: 'HTML' });
      } catch (copyErr) {
        jobLogger.warn({ err: copyErr }, '[DOWNSELL][WORKER] failed to send downsell copy');
      }
    }

    const { transaction } = await createPixForCustomPrice(job.bot_slug, job.telegram_id, downsell.price_cents, {
      bot_id: botId,
      downsell_id: downsell.id,
      source: 'downsell_queue',
    });

    const pixTraceId = generatePixTraceId(transaction.external_id, transaction.id);
    jobLogger.info(
      {
        transaction_id: transaction.id,
        external_id: transaction.external_id,
        price_cents: transaction.value_cents,
        qr_code_base64_len: transaction.qr_code_base64 ? transaction.qr_code_base64.length : null,
        pix_trace_id: pixTraceId,
      },
      '[DOWNSELL][WORKER] pix generated'
    );

    const baseUrlEnv = (process.env.PUBLIC_BASE_URL ?? '').trim();
    const baseUrl = baseUrlEnv || settings.public_base_url || process.env.APP_BASE_URL || '';
    const { message_ids } = await sendPixByChatId(job.telegram_id, transaction, settings, bot.api, baseUrl);
    const lastMessageId = message_ids.length > 0 ? message_ids[message_ids.length - 1] ?? null : null;

    await recordSent(
      {
        bot_slug: job.bot_slug,
        downsell_id: job.downsell_id,
        telegram_id: job.telegram_id,
        transaction_id: String(transaction.id),
        external_id: transaction.external_id,
        sent_message_id: lastMessageId ? String(lastMessageId) : null,
      },
      client
    );

    await markJobAsSent(
      job.id,
      {
        transaction_id: String(transaction.id),
        external_id: transaction.external_id,
        sent_message_id: lastMessageId ? String(lastMessageId) : null,
      },
      client
    );

    await insertFunnelEvent({
      bot_id: botId,
      telegram_id: job.telegram_id,
      downsell_id: job.downsell_id,
      price_cents: transaction.value_cents,
      transaction_external_id: transaction.external_id,
      pix_trace_id: pixTraceId,
      job_id: job.id,
    });

    console.info('[DOWNSELL][SEND][OK]', {
      job_id: job.id,
      external_id: transaction.external_id,
      last_message_id: lastMessageId ?? null,
    });
    jobLogger.info('[DOWNSELL][WORKER] job processed successfully');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
    await markJobAsError(job.id, message, client);
    console.error('[DOWNSELL][SEND][ERROR]', { job_id: job.id, err });
    jobLogger.error({ err }, '[DOWNSELL][WORKER] job failed');
  }
}

interface InsertFunnelEventParams {
  bot_id: string;
  telegram_id: number;
  downsell_id: number;
  price_cents: number;
  transaction_external_id: string;
  pix_trace_id: string;
  job_id: number;
}

async function insertFunnelEvent(params: InsertFunnelEventParams): Promise<void> {
  const eventId = `ds:${params.downsell_id}:${params.telegram_id}`;

  try {
    await funnelService.createEvent({
      bot_id: params.bot_id,
      tg_user_id: params.telegram_id,
      event: 'downsell_sent',
      event_id: eventId,
      price_cents: params.price_cents,
      transaction_id: params.transaction_external_id,
      payload_id: String(params.downsell_id),
      meta: {
        downsell_id: params.downsell_id,
        job_id: params.job_id,
        pix_trace_id: params.pix_trace_id,
      },
    });
  } catch (eventErr) {
    logger.warn(
      {
        err: eventErr,
        bot_id: params.bot_id,
        downsell_id: params.downsell_id,
        job_id: params.job_id,
      },
      '[DOWNSELL][WORKER] failed to record funnel event'
    );
  }
}

export function startDownsellWorker(_app?: unknown): void {
  const workerLogger = logger.child({ worker: 'downsells' });

  const tick = async () => {
    console.info('[DOWNSELL][WORKER][TICK]');
    const locked = await acquireLock();
    if (!locked) {
      return;
    }

    try {
      while (true) {
        const picked = await pickDueJobs(MAX_JOBS_PER_TICK);
        if (!picked) {
          console.info('[DOWNSELL][PICK]', { due_found: 0 });
          break;
        }

        const { client, jobs } = picked;
        console.info('[DOWNSELL][PICK]', { due_found: jobs.length });
        try {
          for (const job of jobs) {
            await handleJob(job, client);
          }
          await client.query('COMMIT');
        } catch (batchErr) {
          await client.query('ROLLBACK').catch(() => undefined);
          workerLogger.error({ err: batchErr }, '[DOWNSELL][WORKER] batch failed, rolled back');
        } finally {
          client.release();
        }

        if (jobs.length < MAX_JOBS_PER_TICK) {
          break;
        }
      }
    } catch (err) {
      workerLogger.error({ err }, '[DOWNSELL][WORKER] tick failed');
    } finally {
      await releaseLock();
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, WORKER_INTERVAL_MS);
}

import type { PoolClient } from 'pg';
import { logger } from '../../../logger.js';
import { pool } from '../../../db/pool.js';
import { sendSafe } from '../../../utils/telegramErrorHandler.js';
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
import { getBotSettings, type BotSettings } from '../../../db/botSettings.js';

type InlineKeyboardMarkup = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

type PlanRow = {
  id: number;
  name: string | null;
  price_cents: number | null;
  is_active: boolean | null;
};


const LOCK_KEY = 4839201;
const WORKER_INTERVAL_MS = 7000;
const MAX_JOBS_PER_TICK = 50;

import {
  buildDownsellKeyboard,
  type DownsellExtraPlan,
  formatPriceBRL,
} from './uiHelpers.js';

async function acquireLock(): Promise<boolean> {
  const { rows } = await pool.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
  return Boolean(rows[0]?.locked);
}

async function releaseLock(): Promise<void> {
  await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch((err) => {
    logger.warn({ err }, '[DOWNSELL][WORKER] failed to release advisory lock');
  });
}

async function sendDownsellMediaIfAny(
  bot: any,
  chatId: number,
  mediaUrl: string | null | undefined,
  mediaType: string | null | undefined,
  jobLogger: any
): Promise<number | null> {
  if (!mediaUrl) return null;

  // 1) Normaliza e tenta inferir pelo mediaType e pela extensão do URL
  const mt = (mediaType ?? '').toLowerCase().trim();

  let ext = '';
  try {
    const u = new URL(mediaUrl);
    const p = u.pathname.toLowerCase();
    ext = p.includes('.') ? p.split('.').pop() || '' : '';
  } catch {
    // se for file_id do Telegram, URL() falha — tudo bem
  }

  // 2) Mapeia para 'video' | 'audio' | 'photo'
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
  // caso contrário, fica 'photo'

  jobLogger.info({ mediaType: mt || null, ext: ext || null, detected: kind, mediaUrl }, '[DOWNSELL][WORKER] media detect');

  try {
    let msg: any;

    // Import sendSafe inline to avoid circular dependency issues
    const { sendSafe } = await import('../../../utils/telegramErrorHandler.js');

    if (kind === 'video') {
      msg = await sendSafe(() => bot.api.sendVideo(chatId, mediaUrl), 'unknown', chatId);
    } else if (kind === 'audio') {
      // Se for OGG/Opus de "voice", o Telegram ainda aceita com sendAudio; se falhar, tentamos sendVoice.
      try {
        msg = await sendSafe(() => bot.api.sendAudio(chatId, mediaUrl), 'unknown', chatId);
      } catch (e) {
        jobLogger.warn({ e }, '[DOWNSELL][WORKER] sendAudio failed — trying sendVoice');
        msg = await sendSafe(() => bot.api.sendVoice(chatId, mediaUrl), 'unknown', chatId);
      }
    } else if (kind === 'animation') {
      // GIFs ficam melhor com sendAnimation
      msg = await sendSafe(() => bot.api.sendAnimation(chatId, mediaUrl), 'unknown', chatId);
    } else {
      msg = await sendSafe(() => bot.api.sendPhoto(chatId, mediaUrl), 'unknown', chatId);
    }

    const id = typeof msg?.message_id === 'number' ? msg.message_id : null;
    return id;
  } catch (err) {
    jobLogger.warn({ err, mediaUrl, mediaType: mt, ext, kind }, '[DOWNSELL][WORKER] failed to send downsell media');
    return null;
  }
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
    const toCents = (value: unknown): number | null => {
      if (value === null || value === undefined) {
        return null;
      }
      const numeric = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };

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
    const priceCents = toCents(downsell?.price_cents);
    const planPriceCents = toCents(downsell?.plan_price_cents);
    const extraPlans = Array.isArray(downsell?.extra_plans) ? downsell.extra_plans : [];
    const resolveLabel = (value: string | null | undefined): string =>
      typeof value === 'string' ? value.trim() : '';
    // Prefer the custom label typed in the admin, but fall back to legacy plan_name values.
    const planLabel = resolveLabel(downsell?.plan_label) || resolveLabel(downsell?.plan_name);
    const hasPlanLabel = planLabel.length > 0;
    const hasPlan = Boolean(downsell?.plan_id);
    const fallbackPlanLabel = hasPlanLabel ? planLabel : 'Oferta especial';
    const primaryPriceCents =
      typeof priceCents === 'number' && priceCents > 0
        ? priceCents
        : typeof planPriceCents === 'number' && planPriceCents > 0
        ? planPriceCents
        : null;
    const hasValidPrice = primaryPriceCents !== null && primaryPriceCents > 0;
    const hasExtraPlanOption = extraPlans.some(
      (plan) =>
        typeof plan?.price_cents === 'number' &&
        plan.price_cents > 0 &&
        typeof plan.label === 'string' &&
        plan.label.trim().length > 0
    );
    const defaultIntro = 'Clique abaixo para continuar:';
    const introText =
      (downsell?.button_intro_text && downsell.button_intro_text.trim()) || defaultIntro;

    if (!downsell || !downsell.active) {
      await markJobAsSkipped(job.id, 'downsell_inactive_or_invalid', client);
      jobLogger.info('[DOWNSELL][WORKER] skipped because downsell inactive or invalid');
      return;
    }

    if (!hasPlan && !hasValidPrice && !hasExtraPlanOption) {
      await markJobAsSkipped(job.id, 'downsell_price_missing', client);
      jobLogger.info('[DOWNSELL][WORKER] skipped due to missing price and no plan');
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

    // 3.1 Envia a mídia do downsell, se existir (antes de qualquer instrução ou botão)
    const mediaMsgId = await sendDownsellMediaIfAny(
      bot,
      job.telegram_id,
      downsell.media_url,
      downsell.media_type,
      jobLogger
    );

    // 3.2 Se mandamos a mídia do downsell, evitamos duplicar a foto do PIX depois.
    //     Criamos uma cópia dos settings com pix_image_url = null para este fluxo.
    const settingsForThisFlow: BotSettings = mediaMsgId
      ? { ...settings, pix_image_url: null }
      : settings;

    if (downsell.copy && downsell.copy.trim().length > 0) {
      try {
        await sendSafe(
          () => bot.api.sendMessage(job.telegram_id, downsell.copy, { parse_mode: 'HTML' }),
          job.bot_slug,
          job.telegram_id
        );
      } catch (copyErr) {
        jobLogger.warn({ err: copyErr }, '[DOWNSELL][WORKER] failed to send downsell copy');
      }
    }

    const keyboard = buildDownsellKeyboard(downsell.id, {
      planLabel: hasPlanLabel ? planLabel : null,
      mainPriceCents: primaryPriceCents,
      extraPlans,
    });

    if (keyboard) {
      const totalButtons =
        (typeof primaryPriceCents === 'number' && primaryPriceCents > 0 ? 1 : 0) +
        (Array.isArray(extraPlans) ? extraPlans.length : 0);
      jobLogger.info({ downsell_id: downsell.id, totalButtons }, '[DOWNSELL][UI] sending CTA');
      const sent = await sendSafe(
        () => bot.api.sendMessage(job.telegram_id, introText, {
          reply_markup: keyboard,
        }),
        job.bot_slug,
        job.telegram_id
      );
      const sentMessageId = sent?.message_id !== undefined ? String(sent.message_id) : null;

      await recordSent(
        {
          bot_slug: job.bot_slug,
          downsell_id: job.downsell_id,
          telegram_id: job.telegram_id,
          sent_message_id: sentMessageId,
        },
        client
      );

      await markJobAsSent(
        job.id,
        {
          sent_message_id: sentMessageId,
        },
        client
      );

      jobLogger.info({ downsell_id: downsell.id }, '[DOWNSELL][WORKER] sent downsell CTA');
      return;
    }

    if (hasPlan) {
      const { rows: planRows } = await pool.query<PlanRow>(
        'SELECT id, name, price_cents, is_active FROM bot_plans WHERE id = $1 AND bot_slug = $2 LIMIT 1',
        [downsell.plan_id, job.bot_slug]
      );
      const plan = planRows[0];
      const planIsActive = plan && plan.is_active !== false;

      if (plan && planIsActive) {
        const planName = plan.name && plan.name.trim().length > 0 ? plan.name.trim() : `Plano #${plan.id}`;
        const planPrice = toCents(plan.price_cents);
        const buttonPriceCents = priceCents ?? planPrice ?? planPriceCents;
        const priceLabel =
          buttonPriceCents !== null && buttonPriceCents > 0
            ? ` — R$ ${(buttonPriceCents / 100).toFixed(2).replace('.', ',')}`
            : '';
        const buttonText = `${planName}${priceLabel}`;
        const keyboard: InlineKeyboardMarkup = {
          inline_keyboard: [[{ text: buttonText, callback_data: `plan:${plan.id}` }]],
        };

        jobLogger.info({ downsell_id: downsell.id, totalButtons: 1 }, '[DOWNSELL][UI] sending CTA');
        const sent = await sendSafe(
          () => bot.api.sendMessage(job.telegram_id, introText, {
            reply_markup: keyboard,
          }),
          job.bot_slug,
          job.telegram_id
        );
        const sentMessageId = sent?.message_id !== undefined ? String(sent.message_id) : null;

        await recordSent(
          {
            bot_slug: job.bot_slug,
            downsell_id: job.downsell_id,
            telegram_id: job.telegram_id,
            sent_message_id: sentMessageId,
          },
          client
        );

        await markJobAsSent(
          job.id,
          {
            sent_message_id: sentMessageId,
          },
          client
        );

        jobLogger.info({ plan_id: plan.id }, '[DOWNSELL][WORKER] sent plan CTA');
        return;
      }

      jobLogger.warn(
        { plan_id: downsell.plan_id, job_id: job.id },
        '[DOWNSELL][WORKER] plan not found or inactive, falling back to PIX'
      );

      if (!hasValidPrice) {
        await markJobAsSkipped(job.id, 'plan_invalid_and_no_price', client);
        jobLogger.warn({ job_id: job.id }, '[DOWNSELL][WORKER] skipped: plan invalid and no price to generate PIX');
        return;
      }
    }

    const pixPriceCents = primaryPriceCents;
    if (pixPriceCents === null || pixPriceCents <= 0) {
      await markJobAsSkipped(job.id, 'downsell_price_missing', client);
      jobLogger.info('[DOWNSELL][WORKER] skipped because price missing for PIX fallback');
      return;
    }

    const { transaction } = await createPixForCustomPrice(job.bot_slug, job.telegram_id, pixPriceCents, {
      bot_id: botId,
      downsell_id: downsell.id,
      origin: 'downsells',
      source: 'downsell_queue',
      plan_label: fallbackPlanLabel,
      price_cents: pixPriceCents,
    });

    jobLogger.info(
      {
        downsell_id: downsell.id,
        plan_label: fallbackPlanLabel,
        price_cents: pixPriceCents,
        tx_id: transaction?.id ?? null,
      },
      '[DOWNSELL][PIX] created'
    );

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
    const { message_ids } = await sendPixByChatId(
      job.telegram_id,
      transaction,
      settingsForThisFlow,
      bot.api,
      baseUrl,
      job.bot_slug
    );
    const lastMessageId = message_ids.length > 0 ? message_ids[message_ids.length - 1] ?? null : null;

    await recordSent(
      {
        bot_slug: job.bot_slug,
        downsell_id: job.downsell_id,
        telegram_id: job.telegram_id,
        transaction_id: String(transaction.id),
        external_id: transaction.external_id,
        sent_message_id: lastMessageId ? String(lastMessageId) : null,
        plan_label: fallbackPlanLabel,
        price_cents: pixPriceCents,
        status: 'sent',
        sent_at: new Date(),
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
          console.info('[DOWNSELL][PICK]', { due_found: 0, status: 'scheduled' });
          break;
        }

        const { client, jobs } = picked;
        console.info('[DOWNSELL][PICK]', { due_found: jobs.length, status: 'scheduled' });
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

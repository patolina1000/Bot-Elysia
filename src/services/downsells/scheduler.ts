import type { Logger } from '../../logger.js';
import { logger } from '../../logger.js';
import { listActiveDownsellsByMoment, type DownsellTrigger } from '../../db/downsells.js';
import { enqueueDownsell, alreadySent } from '../../db/downsellsQueue.js';
import { hasPaidTransactionForUser } from '../../db/payments.js';
import { funnelService } from '../FunnelService.js';

export interface ScheduleDownsellParams {
  botId: string | null;
  botSlug: string;
  telegramId: number;
  moment: DownsellTrigger;
  logger?: Logger;
}

function computeDeliverAt(delayMinutes: number): Date {
  const delayMs = Number.isFinite(delayMinutes) ? Math.max(0, delayMinutes) * 60_000 : 0;
  return new Date(Date.now() + delayMs);
}

type CreateFunnelEventFn = (
  params: Parameters<typeof funnelService.createEvent>[0]
) => ReturnType<typeof funnelService.createEvent>;

const dependencies: {
  listActiveDownsellsByMoment: typeof listActiveDownsellsByMoment;
  enqueueDownsell: typeof enqueueDownsell;
  alreadySent: typeof alreadySent;
  hasPaidTransactionForUser: typeof hasPaidTransactionForUser;
  createFunnelEvent: CreateFunnelEventFn;
} = {
  listActiveDownsellsByMoment,
  enqueueDownsell,
  alreadySent,
  hasPaidTransactionForUser,
  createFunnelEvent: funnelService.createEvent.bind(funnelService),
};

export type SchedulerDependencies = typeof dependencies;

export function __setSchedulerTestDependencies(
  overrides: Partial<SchedulerDependencies>
): () => void {
  const previous = { ...dependencies };
  Object.assign(dependencies, overrides);
  return () => {
    Object.assign(dependencies, previous);
  };
}

export async function scheduleDownsellsForMoment(params: ScheduleDownsellParams): Promise<void> {
  if (typeof params.telegramId !== 'number' || Number.isNaN(params.telegramId)) {
    return;
  }

  const log = (params.logger ?? logger).child({
    bot_slug: params.botSlug,
    telegram_id: params.telegramId,
    downsell_moment: params.moment,
  });

  const hasPaid = await dependencies.hasPaidTransactionForUser(params.botSlug, params.telegramId);
  if (hasPaid) {
    log.info('[DOWNSELL][SCHEDULE] skipped due to paid transaction');
    return;
  }

  const downsells = await dependencies.listActiveDownsellsByMoment(params.botSlug, params.moment);
  const triggerLabel = params.moment === 'after_pix' ? '[DOWNSELL][TRIGGER][AFTER_PIX]' : '[DOWNSELL][TRIGGER][AFTER_START]';
  console.info(triggerLabel, {
    bot_slug: params.botSlug,
    telegram_id: params.telegramId,
    found: downsells.length,
  });
  if (downsells.length === 0) {
    log.debug('[DOWNSELL][SCHEDULE] no active downsells for moment');
    return;
  }

  for (const downsell of downsells) {
    if (!Number.isFinite(downsell.price_cents) || downsell.price_cents <= 0) {
      log.warn({ downsell_id: downsell.id }, '[DOWNSELL][SCHEDULE] invalid price');
      continue;
    }

    const already = await dependencies.alreadySent(params.botSlug, downsell.id, params.telegramId);
    if (already) {
      log.info({ downsell_id: downsell.id }, '[DOWNSELL][SCHEDULE] already sent, skipping');
      continue;
    }

    const deliverAt = computeDeliverAt(downsell.delay_minutes ?? 0);

    try {
      const job = await dependencies.enqueueDownsell({
        bot_slug: params.botSlug,
        downsell_id: downsell.id,
        telegram_id: params.telegramId,
        deliver_at: deliverAt,
      });

      log.info({ downsell_id: downsell.id, job_id: job?.id ?? null, deliver_at: deliverAt.toISOString() }, '[DOWNSELL][SCHEDULE] enqueued');
    } catch (err) {
      log.error({ err, downsell_id: downsell.id }, '[DOWNSELL][SCHEDULE] failed to enqueue');
      continue;
    }

    const eventId = `dsched:${downsell.id}:${params.telegramId}`;
    await dependencies
      .createFunnelEvent({
        bot_id: params.botId ?? null,
        tg_user_id: params.telegramId,
        event: 'downsell_scheduled',
        event_id: eventId,
        price_cents: downsell.price_cents,
        payload_id: String(downsell.id),
        meta: {
          downsell_id: downsell.id,
          moment: params.moment,
        },
      })
      .catch((err) => {
        log.warn({ err, downsell_id: downsell.id }, '[DOWNSELL][SCHEDULE] failed to record funnel event');
      });
  }
}

import type { InlineKeyboardMarkup } from 'grammy/types';
import { listPlans, type BotPlan } from '../../db/plans.js';
import {
  insertOrUpdatePayment,
  type PaymentTransaction,
} from '../../db/payments.js';
import { pool } from '../../db/pool.js';
import { type PushinPayGateway } from '../payments/PushinPayGateway.js';
import { logger } from '../../logger.js';
import { generatePixTraceId } from '../../utils/pixLogging.js';
import { scheduleDownsellsForTrigger } from '../downsellsScheduler.js';

const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function centsToBRL(value: number): string {
  return currencyFormatter.format(value / 100);
}

export async function buildPlansKeyboard(botSlug: string): Promise<InlineKeyboardMarkup | null> {
  const log = logger.child({ bot_slug: botSlug });
  const plans = await listPlans(botSlug);
  log.info(
    {
      bot_slug: botSlug,
      plans: plans.map((plan) => ({
        id: plan.id,
        name: plan.plan_name,
        price_cents: plan.price_cents,
        is_active: plan.is_active,
      })),
    },
    '[PIX][CFG] plans_loaded'
  );

  const activePlans = plans.filter((plan) => plan.is_active);

  if (activePlans.length === 0) {
    return null;
  }

  const buttons = activePlans.map((plan) => [
    {
      text: `${plan.plan_name} - ${centsToBRL(plan.price_cents)}`,
      callback_data: `plan:${plan.id}`,
    },
  ]);

  log.info(
    {
      bot_slug: botSlug,
      buttons: buttons.map(([button]) => ({ text: button.text, cb: button.callback_data })),
    },
    '[PIX][UI] building buttons'
  );

  const mismatched = buttons.flat().filter((button) => !button.callback_data?.startsWith('plan:'));
  if (mismatched.length > 0) {
    log.warn(
      {
        bot_slug: botSlug,
        mismatched: mismatched.map((button) => button.callback_data),
      },
      '[PIX][UI] callback mismatch'
    );
  }

  return {
    inline_keyboard: buttons,
  } satisfies InlineKeyboardMarkup;
}

export interface CreatePixForPlanParams {
  plan: BotPlan;
  gateway: PushinPayGateway;
  telegramId?: number | null;
  payloadId?: string | null;
  botId?: string | null;
}

export interface CreatePixForPlanResult {
  plan: BotPlan;
  transaction: PaymentTransaction;
}

export async function createPixForPlan(
  params: CreatePixForPlanParams
): Promise<CreatePixForPlanResult> {
  const plan = params.plan;
  const created = await params.gateway.createPix({
    value_cents: plan.price_cents,
    splitRules: [],
    botSlug: plan.bot_slug,
    telegram_id: params.telegramId ?? null,
    payload_id: params.payloadId ?? null,
  });

  const createdValue = Number(created?.value);
  const valueCents = Number.isFinite(createdValue) ? Math.trunc(createdValue) : plan.price_cents;

  const transaction = await insertOrUpdatePayment({
    gateway: 'pushinpay',
    external_id: String(created.id),
    status: typeof created.status === 'string' ? created.status : 'created',
    value_cents: valueCents,
    qr_code: typeof created.qr_code === 'string' ? created.qr_code : null,
    qr_code_base64:
      typeof created.qr_code_base64 === 'string' ? created.qr_code_base64 : null,
    webhook_url: typeof created.webhook_url === 'string' ? created.webhook_url : null,
    telegram_id: params.telegramId ?? null,
    payload_id: params.payloadId ?? null,
    plan_name: plan.plan_name,
    meta: {
      planFromBot: true,
      planId: plan.id,
      botSlug: plan.bot_slug,
    },
  });

  const eventId = `pix:${transaction.external_id}`;
  const pix_trace_id = generatePixTraceId(transaction.external_id, transaction.id);

  try {
    const result = await pool.query(
      `INSERT INTO funnel_events (bot_id, tg_user_id, event, event_id, price_cents, transaction_id, payload_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb))
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [
        params.botId ?? null,
        params.telegramId ?? null,
        'pix_created',
        eventId,
        transaction.value_cents,
        transaction.external_id,
        params.payloadId ?? null,
        JSON.stringify({ gateway: 'pushinpay', bot_slug: plan.bot_slug }),
      ]
    );

    // Log apenas se foi inserido (não duplicado)
    if (result.rows.length > 0) {
      logger.child({
        op: 'funnel',
        provider: 'PushinPay',
        provider_id: transaction.external_id,
        bot_slug: plan.bot_slug,
        telegram_id: params.telegramId ?? null,
        payload_id: params.payloadId ?? null,
        transaction_id: transaction.id,
        pix_trace_id,
      }).info({
        event_name: 'pix_created',
        event_id: eventId,
        price_cents: transaction.value_cents,
      }, '[PIX][FUNNEL] pix_created');
    }
  } catch (err) {
    logger.warn({ err, pix_trace_id }, '[plans][pix] Failed to record funnel event');
  }

  if (typeof params.telegramId === 'number' && Number.isFinite(params.telegramId)) {
    try {
      await scheduleDownsellsForTrigger({
        bot_slug: plan.bot_slug,
        telegram_id: params.telegramId,
        trigger: 'after_pix',
        triggerAt: transaction.created_at ?? new Date(),
      });
    } catch (scheduleErr) {
      logger.warn(
        { err: scheduleErr, bot_slug: plan.bot_slug, telegram_id: params.telegramId },
        '[DWN][enqueue] failed after_pix'
      );
    }
  }

  return { plan, transaction };
}

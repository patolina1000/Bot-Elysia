import type { InlineKeyboardMarkup } from 'grammy/types';
import { listPlans, getPlanById, type BotPlan } from '../../db/plans.js';
import {
  insertOrUpdatePayment,
  type PaymentTransaction,
} from '../../db/payments.js';
import { pool } from '../../db/pool.js';
import {
  createPushinPayGatewayFromEnv,
  type PushinPayGateway,
} from '../payments/PushinPayGateway.js';
import { getGateway } from '../payments/registry.js';

const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function centsToBRL(value: number): string {
  return currencyFormatter.format(value / 100);
}

function resolvePushinPayGateway(): PushinPayGateway {
  try {
    return getGateway('pushinpay') as PushinPayGateway;
  } catch (err) {
    return createPushinPayGatewayFromEnv();
  }
}

export async function buildPlansKeyboard(botSlug: string): Promise<InlineKeyboardMarkup | null> {
  const plans = await listPlans(botSlug);
  const activePlans = plans.filter((plan) => plan.is_active);

  if (activePlans.length === 0) {
    return null;
  }

  return {
    inline_keyboard: activePlans.map((plan) => [
      {
        text: `${plan.plan_name} - ${centsToBRL(plan.price_cents)}`,
        callback_data: `plan:${plan.id}`,
      },
    ]),
  } satisfies InlineKeyboardMarkup;
}

export interface CreatePixForPlanParams {
  planId: number;
  telegramId?: number | null;
  payloadId?: string | null;
  botId?: string | null;
  botSlug?: string | null;
}

export interface CreatePixForPlanResult {
  plan: BotPlan;
  transaction: PaymentTransaction;
}

export async function createPixForPlan(
  params: CreatePixForPlanParams
): Promise<CreatePixForPlanResult> {
  const plan = await getPlanById(params.planId);
  if (!plan || !plan.is_active) {
    throw new Error('Plano inválido ou inativo');
  }

  if (params.botSlug && plan.bot_slug !== params.botSlug) {
    throw new Error('Plano não pertence a este bot');
  }

  const gateway = resolvePushinPayGateway();
  const created = await gateway.createPix({
    value_cents: plan.price_cents,
    splitRules: [],
    botSlug: plan.bot_slug,
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

  try {
    await pool.query(
      `INSERT INTO funnel_events (bot_id, tg_user_id, event, event_id, price_cents, transaction_id, payload_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb))
       ON CONFLICT (event_id) DO NOTHING`,
      [
        params.botId ?? null,
        params.telegramId ?? null,
        'pix_created',
        eventId,
        transaction.value_cents,
        transaction.external_id,
        params.payloadId ?? null,
        JSON.stringify({ gateway: 'pushinpay' }),
      ]
    );
  } catch (err) {
    console.warn('[plans][pix] Failed to record funnel event', err);
  }

  return { plan, transaction };
}

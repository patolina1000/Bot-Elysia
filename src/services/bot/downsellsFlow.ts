import { insertOrUpdatePayment, type PaymentTransaction } from '../../db/payments.js';
import { getDownsell } from '../../db/downsells.js';
import { getGateway } from '../payments/registry.js';
import { createPushinPayGatewayFromEnv } from '../payments/PushinPayGateway.js';

export function centsToBRL(v: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v / 100);
}

export async function createPixForDownsell(params: {
  bot_slug: string;
  telegram_id: number;
  downsell_id: number;
}): Promise<{ transaction: PaymentTransaction; title: string }> {
  const ds = await getDownsell(params.downsell_id, params.bot_slug);
  if (!ds || !ds.is_active) {
    throw new Error('Downsell não encontrado ou inativo');
  }

  // Gateway (global por enquanto; mantém compatibilidade)
  let gateway;
  try {
    gateway = getGateway('pushinpay');
  } catch {
    gateway = createPushinPayGatewayFromEnv();
  }

  const px = await gateway.createPix({
    value_cents: ds.price_cents,
    webhookPath: '/api/pushinpay/webhook',
  });

  const tx = await insertOrUpdatePayment({
    gateway: 'pushinpay',
    external_id: px.id,
    status: px.status,
    value_cents: px.value != null ? px.value * 100 : ds.price_cents,
    qr_code: px.qr_code ?? null,
    qr_code_base64: px.qr_code_base64 ?? null,
    webhook_url: px.webhook_url ?? null,
    end_to_end_id: px.end_to_end_id ?? null,
    payer_name: null,
    payer_doc: null,
    telegram_id: params.telegram_id,
    payload_id: null,
    plan_name: ds.title,
    meta: { origin: 'downsell', downsell_id: ds.id, bot_slug: params.bot_slug },
  });

  return { transaction: tx, title: ds.title };
}


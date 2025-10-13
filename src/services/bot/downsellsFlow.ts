import { insertOrUpdatePayment, type PaymentTransaction } from '../../db/payments.js';
import { getDownsell } from '../../db/downsells.js';
import { resolvePixGateway } from '../payments/pixGatewayResolver.js';

export async function createPixForDownsell(params: {
  bot_slug: string;
  telegram_id: number;
  downsell_id: number;
}): Promise<{ transaction: PaymentTransaction; title: string }> {
  const ds = await getDownsell(params.downsell_id, params.bot_slug);
  if (!ds || !ds.is_active) {
    throw new Error('Downsell não encontrado ou inativo');
  }

  const resolution = await resolvePixGateway(params.bot_slug);
  if (!resolution.gateway) {
    throw new Error('pushinpay_gateway_unavailable');
  }

  const px = await resolution.gateway.createPix({
    value_cents: ds.price_cents,
    botSlug: params.bot_slug,
    telegram_id: params.telegram_id,
    payload_id: null,
  });

  const createdValue = Number(px?.value);
  const valueCents = Number.isFinite(createdValue) ? Math.trunc(createdValue) : ds.price_cents;

  const tx = await insertOrUpdatePayment({
    gateway: 'pushinpay',
    external_id: String(px?.id ?? ''),
    status: typeof px?.status === 'string' ? px.status : 'created',
    value_cents: valueCents,
    qr_code: typeof px?.qr_code === 'string' ? px.qr_code : null,
    qr_code_base64: typeof px?.qr_code_base64 === 'string' ? px.qr_code_base64 : null,
    webhook_url:
      typeof px?.webhook_url === 'string'
        ? px.webhook_url
        : typeof resolution.webhookUrl === 'string'
        ? resolution.webhookUrl
        : null,
    end_to_end_id:
      typeof (px as any)?.end_to_end_id === 'string' ? (px as any).end_to_end_id : null,
    payer_name: null,
    payer_doc: null,
    telegram_id: params.telegram_id,
    payload_id: null,
    plan_name: ds.title,
    meta: { origin: 'downsell', downsell_id: ds.id, bot_slug: params.bot_slug },
  });

  return { transaction: tx, title: ds.title };
}


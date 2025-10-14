import type { MyContext } from '../../grammYContext.js';
import type { PaymentTransaction } from '../../../db/payments.js';
import { insertOrUpdatePayment } from '../../../db/payments.js';
import { getSettings } from '../../../db/botSettings.js';
import { resolvePixGateway } from '../../../services/payments/pixGatewayResolver.js';
import { logger } from '../../../logger.js';
import type { Logger } from '../../../logger.js';
import { pool } from '../../../db/pool.js';
import { generatePixTraceId } from '../../../utils/pixLogging.js';
import type { Message } from 'grammy/types';

const DEFAULT_PIX_INSTRUCTIONS = [
  '✅ Como realizar o pagamento:',
  '',
  '1️⃣ Abra o aplicativo do seu banco.',
  '',
  '2️⃣ Selecione a opção “Pagar” ou “Pix”.',
  '',
  '3️⃣ Escolha “Pix Copia e Cola”.',
  '',
  '4️⃣ Cole o código abaixo e confirme o pagamento com segurança.',
].join('\n');

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

export interface PixMessageSender {
  bot_slug: string;
  logger: Logger;
  reply: (
    text: string,
    extra?: Parameters<MyContext['reply']>[1]
  ) => Promise<Message>;
  replyWithPhoto: (
    photo: Parameters<MyContext['replyWithPhoto']>[0],
    extra?: Parameters<MyContext['replyWithPhoto']>[1]
  ) => Promise<Message>;
}

export interface SendPixMessageOptions {
  source?: string;
}

export async function sendPixMessage(
  sender: PixMessageSender,
  transaction: PaymentTransaction,
  _options: SendPixMessageOptions = {}
): Promise<Message> {
  const botSlug = sender.bot_slug;

  if (botSlug) {
    try {
      const settings = await getSettings(botSlug);
      if (settings?.pix_image_url) {
        await sender.replyWithPhoto(settings.pix_image_url);
      }
    } catch (settingsError) {
      sender.logger.warn(
        { err: settingsError, bot_slug: botSlug },
        '[PAYMENTS] Falha ao enviar imagem do PIX'
      );
    }
  }

  await sender.reply(DEFAULT_PIX_INSTRUCTIONS);
  await sender.reply('Copie o código abaixo:');

  if (!transaction.qr_code) {
    throw new Error('Código PIX indisponível.');
  }

  const escaped = escapeHtml(transaction.qr_code);

  await sender.reply(`<pre>${escaped}</pre>`, {
    parse_mode: 'HTML',
  });

  const message = await sender.reply('Após efetuar o pagamento, clique no botão abaixo ⤵️', {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'EFETUEI O PAGAMENTO',
            callback_data: `paid:${transaction.external_id}`,
          },
        ],
        [
          {
            text: 'Qr code',
            web_app: {
              url: `${process.env.APP_BASE_URL}/miniapp/qr?tx=${encodeURIComponent(transaction.external_id)}`,
            },
          },
        ],
      ],
    },
  });

  return message;
}

export interface CreatePixForCustomPriceMeta {
  bot_id?: string | null;
  payload_id?: string | null;
  downsell_id?: number | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreatePixForCustomPriceResult {
  transaction: PaymentTransaction;
}

export async function createPixForCustomPrice(
  botSlug: string,
  telegramId: number | null,
  priceCents: number,
  originMeta: CreatePixForCustomPriceMeta = {}
): Promise<CreatePixForCustomPriceResult> {
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    throw new Error('Valor de PIX inválido.');
  }

  const resolution = await resolvePixGateway(botSlug, logger);
  const gateway = resolution.gateway;

  if (!gateway) {
    throw new Error('Gateway indisponível no momento.');
  }

  const created = await gateway.createPix({
    value_cents: priceCents,
    splitRules: [],
    botSlug,
    telegram_id: telegramId ?? null,
    payload_id: originMeta.payload_id ?? null,
  });

  const createdValue = Number(created?.value);
  const valueCents = Number.isFinite(createdValue) ? Math.trunc(createdValue) : priceCents;

  const metadata: Record<string, unknown> = {
    bot_slug: botSlug,
    origin: 'downsell',
  };

  if (originMeta.downsell_id !== undefined) {
    metadata.downsell_id = originMeta.downsell_id;
  }

  if (originMeta.source) {
    metadata.source = originMeta.source;
  }

  if (originMeta.metadata && typeof originMeta.metadata === 'object') {
    Object.assign(metadata, originMeta.metadata);
  }

  const transaction = await insertOrUpdatePayment({
    gateway: 'pushinpay',
    external_id: String(created.id),
    status: typeof created.status === 'string' ? created.status : 'created',
    value_cents: valueCents,
    qr_code: typeof created.qr_code === 'string' ? created.qr_code : null,
    qr_code_base64:
      typeof created.qr_code_base64 === 'string' ? created.qr_code_base64 : null,
    webhook_url:
      typeof created.webhook_url === 'string'
        ? created.webhook_url
        : resolution.webhookUrl ?? null,
    telegram_id: telegramId ?? null,
    payload_id: originMeta.payload_id ?? null,
    plan_name: null,
    meta: metadata,
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
        originMeta.bot_id ?? null,
        telegramId ?? null,
        'pix_created',
        eventId,
        transaction.value_cents,
        transaction.external_id,
        originMeta.payload_id ?? null,
        JSON.stringify({
          gateway: 'pushinpay',
          bot_slug: botSlug,
          origin: 'downsell',
          downsell_id: originMeta.downsell_id ?? null,
        }),
      ]
    );

    if (result.rows.length > 0) {
      logger
        .child({
          op: 'funnel',
          provider: 'PushinPay',
          provider_id: transaction.external_id,
          bot_slug: botSlug,
          telegram_id: telegramId ?? null,
          payload_id: originMeta.payload_id ?? null,
          transaction_id: transaction.id,
          pix_trace_id,
        })
        .info({ event_name: 'pix_created', event_id: eventId, price_cents: transaction.value_cents }, '[PIX][FUNNEL] pix_created');
    }
  } catch (err) {
    logger.warn({ err, pix_trace_id }, '[payments][downsell] Failed to record funnel event');
  }

  return { transaction };
}

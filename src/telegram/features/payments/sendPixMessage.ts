import type { MyContext } from '../../grammYContext.js';
import type { PaymentTransaction } from '../../../db/payments.js';
import { insertOrUpdatePayment } from '../../../db/payments.js';
import { getSettings } from '../../../db/botSettings.js';
import type { BotSettings } from '../../../db/botSettings.js';
import { resolvePixGateway } from '../../../services/payments/pixGatewayResolver.js';
import { logger } from '../../../logger.js';
import type { Logger } from '../../../logger.js';
import { pool } from '../../../db/pool.js';
import { generatePixTraceId } from '../../../utils/pixLogging.js';
import type { Message } from '@grammyjs/types';
import {
  buildPixEmvBlock,
  buildPixInstructionText,
  buildPixKeyboard,
  resolvePixMiniAppUrl,
} from './pixMessageParts.js';

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
  let settings: BotSettings = {
    bot_slug: botSlug,
    pix_image_url: null,
    offers_text: null,
    public_base_url: null,
  };

  if (botSlug) {
    try {
      settings = await getSettings(botSlug);
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

  const instructionText = buildPixInstructionText(settings, transaction);
  await sender.reply(instructionText);
  await sender.reply('Copie o código abaixo:');

  const emvBlock = buildPixEmvBlock(transaction);
  await sender.reply(emvBlock, {
    parse_mode: 'HTML',
  });

  const baseUrl = settings.public_base_url ?? process.env.PUBLIC_BASE_URL ?? process.env.APP_BASE_URL ?? '';
  const miniAppUrl = resolvePixMiniAppUrl(transaction.external_id, baseUrl);
  const keyboard = buildPixKeyboard({
    miniAppUrl,
    confirmCallbackData: `paid:${transaction.external_id}`,
  });
  const message = await sender.reply('Após efetuar o pagamento, clique no botão abaixo ⤵️', {
    reply_markup: keyboard,
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

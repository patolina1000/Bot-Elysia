import { Composer, InputFile } from 'grammy';
import { MyContext } from '../../grammYContext.js';
import {
  createPixForPlan,
  centsToBRL,
} from '../../../services/bot/plans.js';
import { getPaymentByExternalId } from '../../../db/payments.js';
import { getPlanById } from '../../../db/plans.js';
import { getDownsellById } from '../../../db/downsells.js';
import type { BotDownsell } from '../../../db/downsells.js';
import { resolvePixGateway } from '../../../services/payments/pixGatewayResolver.js';
import { generatePixTraceId } from '../../../utils/pixLogging.js';
import { sendPixMessage, createPixForCustomPrice } from './sendPixMessage.js';
import { scheduleDownsellsForMoment } from '../../../services/downsells/scheduler.js';
import { getOption } from '../../../db/downsellOptions.js';
import { sendDownsellMediaIfAny } from '../downsells/dispatcher.js';
import { getBotSettings } from '../../../db/botSettings.js';
import { sendPixByChatId } from './sendPixByChatId.js';

export const paymentsFeature = new Composer<MyContext>();

paymentsFeature.on('callback_query:data', async (ctx, next) => {
  const data = ctx.callbackQuery?.data ?? '';
  if (!data) {
    await next();
    return;
  }

  ctx.logger.info({ bot_slug: ctx.bot_slug, callback_data: data }, '[DISPATCH] callback received');

  const isPlanAction = data.startsWith('plan:');
  ctx.logger.info(
    { bot_slug: ctx.bot_slug, pattern: 'plan:', matched: isPlanAction },
    '[DISPATCH] checking'
  );
  if (data.startsWith('plan:')) {
    const rawId = data.slice('plan:'.length);
    const planId = Number.parseInt(rawId, 10);

    if (!Number.isFinite(planId)) {
      ctx.logger.warn(
        { bot_slug: ctx.bot_slug, callback_data: data },
        '[PIX][GUARD] unknown_action'
      );
      await ctx.answerCallbackQuery({ text: 'Plano inválido.', show_alert: true });
      return;
    }

    const paymentsEnabled = ctx.bot_features?.['payments'] !== false;
    if (!paymentsEnabled) {
      ctx.logger.warn(
        { bot_slug: ctx.bot_slug, callback_data: data, plan_id: planId },
        '[PIX][GUARD] payments_disabled'
      );
      await ctx.answerCallbackQuery({ text: 'Pagamentos indisponíveis no momento.', show_alert: true });
      return;
    }

    const plan = await getPlanById(planId);
    if (!plan || !plan.is_active || !Number.isFinite(plan.price_cents) || plan.price_cents <= 0) {
      ctx.logger.warn(
        {
          bot_slug: ctx.bot_slug,
          callback_data: data,
          plan_id: planId,
          price_cents: plan?.price_cents ?? null,
        },
        '[PIX][GUARD] plan_or_price_missing'
      );
      await ctx.answerCallbackQuery({ text: 'Plano inválido.', show_alert: true });
      return;
    }

    const resolution = await resolvePixGateway(ctx.bot_slug, ctx.logger);
    if (!resolution.gateway || !resolution.token) {
      ctx.logger.warn(
        {
          bot_slug: ctx.bot_slug,
          callback_data: data,
          plan_id: planId,
          price_cents: plan.price_cents,
        },
        '[PIX][GUARD] gateway_unresolved_or_token_missing'
      );
      await ctx.answerCallbackQuery({ text: 'Gateway indisponível no momento.', show_alert: true });
      return;
    }

    if (!resolution.webhookUrl) {
      ctx.logger.warn(
        {
          bot_slug: ctx.bot_slug,
          callback_data: data,
          plan_id: planId,
          price_cents: plan.price_cents,
        },
        '[PIX][GUARD] webhook_url_missing'
      );
      await ctx.answerCallbackQuery({ text: 'Pagamento indisponível. Contate o suporte.', show_alert: true });
      return;
    }

    const telegramId = ctx.from?.id ?? ctx.chat?.id ?? null;
    const pix_trace_id = 'tx:unknown';

    try {
      ctx.logger.info({
        op: 'create',
        provider: 'PushinPay',
        bot_slug: ctx.bot_slug,
        telegram_id: telegramId,
        payload_id: null,
        plan_id: plan.id,
        price_cents: plan.price_cents,
        pix_trace_id,
      }, '[PIX][CREATE] telegram callback');

      const { transaction } = await createPixForPlan({
        plan,
        gateway: resolution.gateway,
        telegramId,
        payloadId: null,
        botId: ctx.bot_id,
      });

      if (!transaction.qr_code) {
        throw new Error('Código PIX indisponível.');
      }

      const final_trace_id = generatePixTraceId(transaction.external_id, transaction.id);
      ctx.logger.info({
        op: 'create',
        provider: 'PushinPay',
        provider_id: transaction.external_id,
        transaction_id: transaction.id,
        bot_slug: ctx.bot_slug,
        telegram_id: telegramId,
        price_cents: transaction.value_cents,
        pix_trace_id: final_trace_id,
      }, '[PIX][CREATE] telegram pix generated');

      await sendPixMessage(ctx, transaction, { source: 'plan' });

      if (typeof telegramId === 'number' && !Number.isNaN(telegramId)) {
        try {
          await scheduleDownsellsForMoment({
            botId: ctx.bot_id ?? null,
            botSlug: ctx.bot_slug,
            telegramId,
            moment: 'after_pix',
            logger: ctx.logger,
          });
        } catch (scheduleErr) {
          ctx.logger.warn({ err: scheduleErr }, '[DOWNSELL][SCHEDULE] failed after pix creation');
        }
      }

      await ctx.answerCallbackQuery();
    } catch (err) {
      ctx.logger.error(
        {
          err,
          op: 'create',
          provider: 'PushinPay',
          data,
          plan_id: planId,
          pix_trace_id,
        },
        '[PIX][ERROR] telegram create failed'
      );
      await ctx.answerCallbackQuery({
        text: 'Erro ao gerar PIX. Tente novamente em instantes.',
        show_alert: true,
      });
    }

    return;
  }

  const isDownsellOptionAction = data.startsWith('DSL:');
  ctx.logger.info(
    { bot_slug: ctx.bot_slug, pattern: 'DSL:', matched: isDownsellOptionAction },
    '[DISPATCH] checking'
  );
  if (isDownsellOptionAction) {
    const [, sDownsellId, sOptionId] = data.split(':');
    const downsellId = Number.parseInt(sDownsellId ?? '', 10);
    const optionId = Number.parseInt(sOptionId ?? '', 10);

    if (!Number.isFinite(downsellId) || !Number.isFinite(optionId)) {
      ctx.logger.warn(
        { bot_slug: ctx.bot_slug, callback_data: data },
        '[PIX][GUARD] unknown_downsell_option_action'
      );
      await ctx.answerCallbackQuery({ text: 'Opção inválida.', show_alert: true });
      return;
    }

    await handleDownsellOptionPick(ctx, downsellId, optionId);
    return;
  }

  const isDownsellSingleAction = data.startsWith('DSL1:');
  ctx.logger.info(
    { bot_slug: ctx.bot_slug, pattern: 'DSL1:', matched: isDownsellSingleAction },
    '[DISPATCH] checking'
  );
  if (isDownsellSingleAction) {
    const rawId = data.slice('DSL1:'.length);
    const downsellId = Number.parseInt(rawId, 10);

    if (!Number.isFinite(downsellId)) {
      ctx.logger.warn(
        { bot_slug: ctx.bot_slug, callback_data: data },
        '[PIX][GUARD] unknown_downsell_single_action'
      );
      await ctx.answerCallbackQuery({ text: 'Oferta inválida.', show_alert: true });
      return;
    }

    await handleDownsellSinglePick(ctx, downsellId, data);
    return;
  }

  const isDownsellAction = data.startsWith('downsell:');
  ctx.logger.info(
    { bot_slug: ctx.bot_slug, pattern: 'downsell:', matched: isDownsellAction },
    '[DISPATCH] checking'
  );
  if (isDownsellAction) {
    const rawId = data.slice('downsell:'.length);
    const downsellId = Number.parseInt(rawId, 10);

    if (!Number.isFinite(downsellId)) {
      ctx.logger.warn(
        { bot_slug: ctx.bot_slug, callback_data: data },
        '[PIX][GUARD] unknown_downsell_action'
      );
      await ctx.answerCallbackQuery({ text: 'Oferta inválida.', show_alert: true });
      return;
    }

    await handleDownsellSinglePick(ctx, downsellId, data);
    return;
  }

  const isQrAction = data.startsWith('qr:');

  ctx.logger.info(
    { bot_slug: ctx.bot_slug, pattern: 'qr:', matched: isQrAction },
    '[DISPATCH] checking'
  );
  if (isQrAction) {
    const txid = data.slice('qr:'.length);

    try {
      const transaction = await getPaymentByExternalId('pushinpay', txid);
      const qrBase64 = transaction?.qr_code_base64 ?? null;

      if (!qrBase64) {
        await ctx.answerCallbackQuery({
          text: 'QR indisponível no momento. Use o código Pix Copia e Cola.',
          show_alert: true,
        });
        return;
      }

      const base64Content = qrBase64.includes('base64,')
        ? qrBase64.split('base64,')[1] ?? ''
        : qrBase64;

      if (!base64Content) {
        await ctx.answerCallbackQuery({
          text: 'QR indisponível no momento. Use o código Pix Copia e Cola.',
          show_alert: true,
        });
        return;
      }

      const buffer = Buffer.from(base64Content, 'base64');
      await ctx.replyWithPhoto(new InputFile(buffer, 'pix.png'));
      await ctx.answerCallbackQuery();
    } catch (err) {
      ctx.logger.error({ err, data }, '[PAYMENTS] Failed to send QR code');
      await ctx.answerCallbackQuery({
        text: 'Falha ao enviar QR. Tente novamente.',
        show_alert: true,
      });
    }

    return;
  }

  const isPaidAction = data.startsWith('paid:');
  ctx.logger.info(
    { bot_slug: ctx.bot_slug, pattern: 'paid:', matched: isPaidAction },
    '[DISPATCH] checking'
  );
  if (isPaidAction) {
    const txid = data.slice('paid:'.length);
    const pix_trace_id = generatePixTraceId(txid, null);

    ctx.logger.info({
      op: 'status',
      provider: 'PushinPay',
      provider_id: txid,
      bot_slug: ctx.bot_slug,
      telegram_id: ctx.from?.id ?? ctx.chat?.id ?? null,
      pix_trace_id,
    }, '[PIX][STATUS] telegram check');

    try {
      const resolution = await resolvePixGateway(ctx.bot_slug, ctx.logger);
      const gateway = resolution.gateway;
      if (!gateway) {
        ctx.logger.warn(
          { bot_slug: ctx.bot_slug, callback_data: data },
          '[PIX][GUARD] gateway_unresolved_or_token_missing'
        );
        await ctx.answerCallbackQuery({ text: 'Gateway indisponível no momento.', show_alert: true });
        return;
      }
      const info = await gateway.getTransaction(txid);
      const status = String(info?.status ?? 'created');
      const normalized = status.toLowerCase();

      ctx.logger.info({
        op: 'status',
        provider: 'PushinPay',
        provider_id: txid,
        status,
        pix_trace_id,
      }, '[PIX][STATUS] telegram result');

      if (normalized === 'paid') {
        ctx.logger.info({
          op: 'status',
          provider: 'PushinPay',
          provider_id: txid,
          status_next: 'paid',
          bot_slug: ctx.bot_slug,
          telegram_id: ctx.from?.id ?? ctx.chat?.id ?? null,
          pix_trace_id,
        }, '[PIX][STATUS] telegram payment confirmed');

        try {
          await ctx.editMessageText('🎉 Pagamento <b>confirmado</b>! Em instantes você será liberado.', {
            parse_mode: 'HTML',
          });
        } catch (editError) {
          ctx.logger.warn({ err: editError, data }, '[PAYMENTS] Failed to edit message after payment');
          await ctx.reply('🎉 Pagamento <b>confirmado</b>! Em instantes você será liberado.', {
            parse_mode: 'HTML',
          });
        }

        await ctx.answerCallbackQuery({ text: 'Pagamento confirmado!' });
      } else {
        await ctx.answerCallbackQuery({
          text: `Status: ${status}. Se já pagou, aguarde a confirmação.`,
          show_alert: true,
        });
      }
    } catch (err) {
      ctx.logger.error({
        err,
        op: 'status',
        provider: 'PushinPay',
        provider_id: txid,
        data,
        pix_trace_id,
      }, '[PIX][ERROR] telegram verify failed');
      await ctx.answerCallbackQuery({
        text: 'Não consegui consultar agora. Tente novamente mais tarde.',
        show_alert: true,
      });
    }

    return;
  }

  const purchaseLike = /^(buy|pix|plan|offer)/i.test(data);
  if (purchaseLike) {
    ctx.logger.warn({ bot_slug: ctx.bot_slug, callback_data: data }, '[PIX][DISPATCH] no handler matched');
  }

  await next();
});

function resolveChatId(ctx: MyContext): number | null {
  if (typeof ctx.chat?.id === 'number') {
    return ctx.chat.id;
  }

  const callbackChatId = ctx.callbackQuery?.message?.chat?.id;
  if (typeof callbackChatId === 'number') {
    return callbackChatId;
  }

  if (typeof ctx.from?.id === 'number') {
    return ctx.from.id;
  }

  return null;
}

interface DownsellPickParams {
  ctx: MyContext;
  downsell: BotDownsell;
  label: string;
  priceCents: number;
  optionId?: number | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
}

async function processDownsellPick(params: DownsellPickParams): Promise<boolean> {
  const { ctx, downsell, label, priceCents, optionId = null } = params;

  const chatId = resolveChatId(ctx);
  if (chatId === null) {
    ctx.logger.warn({ downsell_id: downsell.id }, '[PIX][GUARD] chat_id_missing');
    await ctx.answerCallbackQuery({ text: 'Conversa indisponível no momento.', show_alert: true });
    return false;
  }

  const settings = await getBotSettings(ctx.bot_slug);
  const mediaMsgId = await sendDownsellMediaIfAny(
    { api: ctx.api },
    chatId,
    params.mediaUrl ?? downsell.media_url,
    params.mediaType ?? downsell.media_type,
    ctx.logger
  );

  const settingsForThisFlow = mediaMsgId ? { ...settings, pix_image_url: null } : settings;

  const meta: Record<string, unknown> = {
    origin: 'downsell',
    downsell_id: downsell.id,
    option_id: optionId,
    plan_label: label,
  };

  const { transaction } = await createPixForCustomPrice(ctx.bot_slug, chatId, priceCents, {
    bot_id: ctx.bot_id ?? null,
    downsell_id: downsell.id,
    source: 'downsells_callback',
    metadata: meta,
  });

  if (!transaction.qr_code) {
    throw new Error('Código PIX indisponível.');
  }

  const pix_trace_id = generatePixTraceId(transaction.external_id, transaction.id);
  ctx.logger.info(
    {
      op: 'create',
      provider: 'PushinPay',
      provider_id: transaction.external_id,
      transaction_id: transaction.id,
      bot_slug: ctx.bot_slug,
      telegram_id: chatId,
      price_cents: transaction.value_cents,
      pix_trace_id,
      downsell_id: downsell.id,
      option_id: optionId,
    },
    '[PIX][CREATE] downsell pix generated'
  );

  const baseUrlEnv = (process.env.PUBLIC_BASE_URL ?? '').trim();
  const baseUrl = baseUrlEnv || settingsForThisFlow.public_base_url || process.env.APP_BASE_URL || '';

  await sendPixByChatId(chatId, transaction, settingsForThisFlow, ctx.api, baseUrl);

  if (typeof chatId === 'number' && !Number.isNaN(chatId)) {
    try {
      await scheduleDownsellsForMoment({
        botId: ctx.bot_id ?? null,
        botSlug: ctx.bot_slug,
        telegramId: chatId,
        moment: 'after_pix',
        logger: ctx.logger,
      });
    } catch (scheduleErr) {
      ctx.logger.warn({ err: scheduleErr }, '[DOWNSELL][SCHEDULE] failed after downsell pix');
    }
  }

  await ctx.answerCallbackQuery();
  return true;
}

async function handleDownsellOptionPick(ctx: MyContext, downsellId: number, optionId: number): Promise<void> {
  const paymentsEnabled = ctx.bot_features?.['payments'] !== false;
  if (!paymentsEnabled) {
    ctx.logger.warn(
      { bot_slug: ctx.bot_slug, callback_data: `DSL:${downsellId}:${optionId}` },
      '[PIX][GUARD] payments_disabled'
    );
    await ctx.answerCallbackQuery({ text: 'Pagamentos indisponíveis no momento.', show_alert: true });
    return;
  }

  const downsell = await getDownsellById(downsellId);
  if (!downsell || !downsell.active || downsell.bot_slug !== ctx.bot_slug) {
    ctx.logger.warn(
      { bot_slug: ctx.bot_slug, callback_data: `DSL:${downsellId}:${optionId}`, downsell_id: downsellId },
      '[PIX][GUARD] downsell_not_found_or_inactive'
    );
    await ctx.answerCallbackQuery({ text: 'Opção indisponível.', show_alert: true });
    return;
  }

  const option = await getOption(optionId);
  if (!option || option.downsell_id !== downsellId || !option.active) {
    ctx.logger.warn(
      { bot_slug: ctx.bot_slug, downsell_id: downsellId, option_id: optionId },
      '[PIX][GUARD] downsell_option_invalid'
    );
    await ctx.answerCallbackQuery({ text: 'Opção indisponível.', show_alert: true });
    return;
  }

  const priceCents = Number(option.price_cents);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    ctx.logger.warn(
      { bot_slug: ctx.bot_slug, downsell_id: downsellId, option_id: optionId, price_cents: option.price_cents },
      '[PIX][GUARD] downsell_option_price_missing'
    );
    await ctx.answerCallbackQuery({ text: 'Preço indisponível no momento.', show_alert: true });
    return;
  }

  ctx.logger.info(
    { downsell_id: downsellId, option_id: optionId, label: option.label, price_cents: priceCents },
    '[DOWNSELL][PICK] option'
  );

  try {
    await processDownsellPick({
      ctx,
      downsell,
      label: option.label,
      priceCents,
      optionId: option.id,
      mediaUrl: option.media_url ?? downsell.media_url,
      mediaType: option.media_type ?? downsell.media_type,
    });
  } catch (err) {
    ctx.logger.error(
      { err, downsell_id: downsellId, option_id: optionId },
      '[PIX][ERROR] downsell option create failed'
    );
    await ctx.answerCallbackQuery({ text: 'Erro ao gerar PIX. Tente novamente em instantes.', show_alert: true });
  }
}

async function handleDownsellSinglePick(
  ctx: MyContext,
  downsellId: number,
  callbackData?: string
): Promise<void> {
  const paymentsEnabled = ctx.bot_features?.['payments'] !== false;
  if (!paymentsEnabled) {
    ctx.logger.warn({ bot_slug: ctx.bot_slug, callback_data: callbackData ?? `DSL1:${downsellId}` }, '[PIX][GUARD] payments_disabled');
    await ctx.answerCallbackQuery({ text: 'Pagamentos indisponíveis no momento.', show_alert: true });
    return;
  }

  const downsell = await getDownsellById(downsellId);
  if (!downsell || !downsell.active || downsell.bot_slug !== ctx.bot_slug) {
    ctx.logger.warn(
      { bot_slug: ctx.bot_slug, downsell_id: downsellId, callback_data: callbackData ?? `DSL1:${downsellId}` },
      '[PIX][GUARD] downsell_not_found_or_inactive'
    );
    await ctx.answerCallbackQuery({ text: 'Oferta indisponível.', show_alert: true });
    return;
  }

  const planLabel = (downsell.plan_label ?? downsell.plan_name ?? '').trim();
  const label = planLabel.length > 0 ? planLabel : 'Oferta';

  const primaryPrice =
    typeof downsell.price_cents === 'number' && Number.isFinite(downsell.price_cents) && downsell.price_cents > 0
      ? downsell.price_cents
      : null;
  const fallbackPrice =
    typeof downsell.plan_price_cents === 'number' &&
    Number.isFinite(downsell.plan_price_cents) &&
    downsell.plan_price_cents > 0
      ? downsell.plan_price_cents
      : null;
  const priceCents = primaryPrice ?? fallbackPrice;

  if (!priceCents) {
    ctx.logger.warn(
      { bot_slug: ctx.bot_slug, downsell_id: downsellId, callback_data: callbackData ?? `DSL1:${downsellId}` },
      '[PIX][GUARD] downsell_price_missing'
    );
    await ctx.answerCallbackQuery({ text: 'Preço indisponível no momento.', show_alert: true });
    return;
  }

  ctx.logger.info(
    { downsell_id: downsellId, option_id: null, label, price_cents: priceCents },
    '[DOWNSELL][PICK] single'
  );

  try {
    await processDownsellPick({
      ctx,
      downsell,
      label,
      priceCents,
      optionId: null,
      mediaUrl: downsell.media_url,
      mediaType: downsell.media_type,
    });
  } catch (err) {
    ctx.logger.error(
      { err, downsell_id: downsellId, callback_data: callbackData ?? `DSL1:${downsellId}` },
      '[PIX][ERROR] downsell create failed'
    );
    await ctx.answerCallbackQuery({ text: 'Erro ao gerar PIX. Tente novamente em instantes.', show_alert: true });
  }
}

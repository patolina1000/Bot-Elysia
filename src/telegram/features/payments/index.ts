import { Composer, InputFile } from 'grammy';
import { MyContext } from '../../grammYContext.js';
import {
  createPixForPlan,
  centsToBRL,
} from '../../../services/bot/plans.js';
import { getPaymentByExternalId } from '../../../db/payments.js';
import { getPlanById } from '../../../db/plans.js';
import { resolvePixGateway } from '../../../services/payments/pixGatewayResolver.js';
import { getSettings } from '../../../db/botSettings.js';
import { generatePixTraceId } from '../../../utils/pixLogging.js';

export const paymentsFeature = new Composer<MyContext>();

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

      const botSlug = ctx.bot_slug;
      if (botSlug) {
        try {
          const settings = await getSettings(botSlug);
          if (settings?.pix_image_url) {
            await ctx.replyWithPhoto(settings.pix_image_url);
          }
        } catch (settingsError) {
          ctx.logger.warn({ err: settingsError, botSlug }, '[PAYMENTS] Falha ao enviar imagem do PIX');
        }
      }

      const instructions = [
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
      await ctx.reply(instructions);

      await ctx.reply('Copie o código abaixo:');

      await ctx.reply(`<pre>${escapeHtml(transaction.qr_code)}</pre>`, {
        parse_mode: 'HTML',
      });

      await ctx.reply('Após efetuar o pagamento, clique no botão abaixo ⤵️', {
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

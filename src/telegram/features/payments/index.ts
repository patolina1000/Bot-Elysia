import { Composer, InputFile } from 'grammy';
import { MyContext } from '../../grammYContext.js';
import {
  createPixForPlan,
  centsToBRL,
} from '../../../services/bot/plans.js';
import { getPaymentByExternalId } from '../../../db/payments.js';
import {
  createPushinPayGatewayFromEnv,
  type PushinPayGateway,
} from '../../../services/payments/PushinPayGateway.js';
import { getGateway } from '../../../services/payments/registry.js';
import { getSettings } from '../../../db/botSettings.js';

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

function resolvePushinPayGateway(): PushinPayGateway {
  try {
    return getGateway('pushinpay') as PushinPayGateway;
  } catch (err) {
    return createPushinPayGatewayFromEnv();
  }
}

paymentsFeature.on('callback_query:data', async (ctx, next) => {
  const data = ctx.callbackQuery?.data ?? '';
  if (!data) {
    await next();
    return;
  }

  if (data.startsWith('plan:')) {
    const rawId = data.slice('plan:'.length);
    const planId = Number.parseInt(rawId, 10);

    if (!Number.isFinite(planId)) {
      await ctx.answerCallbackQuery({ text: 'Plano inválido.', show_alert: true });
      return;
    }

    try {
      const telegramId = ctx.from?.id ?? ctx.chat?.id ?? null;
      const { plan, transaction } = await createPixForPlan({
        planId,
        telegramId,
        payloadId: null,
        botId: ctx.bot_id,
        botSlug: ctx.bot_slug,
      });

      if (!transaction.qr_code) {
        throw new Error('Código PIX indisponível.');
      }

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
      ctx.logger.error({ err, data }, '[PAYMENTS] Failed to create PIX');
      await ctx.answerCallbackQuery({
        text: 'Erro ao gerar PIX. Tente novamente em instantes.',
        show_alert: true,
      });
    }

    return;
  }

  if (data.startsWith('qr:')) {
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

  if (data.startsWith('paid:')) {
    const txid = data.slice('paid:'.length);

    try {
      const gateway = resolvePushinPayGateway();
      const info = await gateway.getTransaction(txid);
      const status = String(info?.status ?? 'created');
      const normalized = status.toLowerCase();

      if (normalized === 'paid') {
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
      ctx.logger.error({ err, data }, '[PAYMENTS] Failed to verify payment');
      await ctx.answerCallbackQuery({
        text: 'Não consegui consultar agora. Tente novamente mais tarde.',
        show_alert: true,
      });
    }

    return;
  }

  await next();
});

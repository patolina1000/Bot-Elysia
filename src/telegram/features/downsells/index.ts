import { Composer } from 'grammy';
import type { MyContext } from '../../grammYContext.js';
import { createPixForDownsell } from '../../../services/bot/downsellsFlow.js';
import { getSettings } from '../../../db/botSettings.js';

export const downsellsFeature = new Composer<MyContext>();

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

// Callback: gerar PIX para downsell
downsellsFeature.on('callback_query:data', async (ctx, next) => {
  const data = ctx.callbackQuery?.data ?? '';
  if (!data.startsWith('ds_pix:')) return next();

  const idStr = data.slice('ds_pix:'.length);
  const downsellId = Number(idStr);
  if (!Number.isFinite(downsellId)) {
    await ctx.answerCallbackQuery({ text: 'Downsell inválido', show_alert: true });
    return;
  }

  try {
    await ctx.answerCallbackQuery({ text: 'Gerando PIX…' });
    const { transaction } = await createPixForDownsell({
      bot_slug: ctx.bot_slug!,
      telegram_id: ctx.from!.id,
      downsell_id: downsellId,
    });

    // 1) Imagem configurável do bot (mesmo do fluxo principal)
    try {
      const settings = await getSettings(ctx.bot_slug!);
      if (settings?.pix_image_url) {
        await ctx.replyWithPhoto(settings.pix_image_url);
      }
    } catch (settingsError) {
      ctx.logger?.warn({ err: settingsError, bot_slug: ctx.bot_slug }, '[DOWNSELL][PIX] pix_image_url failed');
    }

    // 2) Instruções + Pix Copia e Cola
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
    await ctx.reply(`<pre>${escapeHtml(transaction.qr_code ?? 'indisponível')}</pre>`, { parse_mode: 'HTML' });

    // 3) Botões: EFETUEI O PAGAMENTO + Mini App do QR
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
    ctx.logger.error({ err, downsellId }, '[DOWNSELL][PIX] erro ao gerar');
    await ctx.answerCallbackQuery({ text: 'Não consegui criar o PIX agora. Tente mais tarde.', show_alert: true });
  }
});


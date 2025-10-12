import { Composer, InputFile } from 'grammy';
import type { MyContext } from '../../grammYContext.js';
import { createPixForDownsell, centsToBRL } from '../../../services/bot/downsellsFlow.js';

export const downsellsFeature = new Composer<MyContext>();

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
    const { transaction, title } = await createPixForDownsell({
      bot_slug: ctx.bot_slug!,
      telegram_id: ctx.from!.id,
      downsell_id: downsellId,
    });

    const brl = centsToBRL(transaction.value_cents);

    const caption =
      `✅ PIX criado para **${title}**\n` +
      `Valor: *${brl}*\n\n` +
      'Pague escaneando o QR code abaixo.';

    const fallbackMessage =
      `✅ PIX criado para **${title}**\n` +
      `Valor: *${brl}*\n\n` +
      'Copia e Cola:\n' +
      `\`${transaction.qr_code ?? 'indisponível'}\``;

    const sendPhotoFromBase64 = async (): Promise<boolean> => {
      const raw = transaction.qr_code_base64;
      if (!raw) return false;
      const base64Content = raw.includes('base64,') ? raw.split('base64,')[1] ?? '' : raw;
      if (!base64Content) return false;
      const buf = Buffer.from(base64Content, 'base64');
      await ctx.replyWithPhoto(new InputFile(buf, 'pix.png'), {
        caption,
        parse_mode: 'Markdown',
      });
      return true;
    };

    try {
      const sent = await sendPhotoFromBase64();
      if (!sent) {
        if (transaction.qr_code) {
          await ctx.reply(fallbackMessage, { parse_mode: 'Markdown' });
        } else {
          await ctx.answerCallbackQuery({
            text: 'QR indisponível no momento. Use o código Pix Copia e Cola.',
            show_alert: true,
          });
        }
      }
    } catch (err) {
      ctx.logger.warn({ err, downsellId }, '[DOWNSELL][PIX] failed to send qr image');
      if (transaction.qr_code) {
        await ctx.reply(fallbackMessage, { parse_mode: 'Markdown' });
      } else {
        await ctx.answerCallbackQuery({ text: 'Erro ao gerar a imagem do QR.', show_alert: true });
      }
    }
  } catch (err) {
    ctx.logger.error({ err, downsellId }, '[DOWNSELL][PIX] erro ao gerar');
    await ctx.answerCallbackQuery({ text: 'Não consegui criar o PIX agora. Tente mais tarde.', show_alert: true });
  }
});


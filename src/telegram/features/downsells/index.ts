import { Composer, InputFile } from 'grammy';
import type { MyContext } from '../../grammYContext.js';
import { createPixForDownsell, centsToBRL } from '../../../services/bot/downsellsFlow.js';
import { getSettings } from '../../../db/botSettings.js';

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

    const settings = await getSettings(ctx.bot_slug!);
    const caption =
      `✅ PIX criado para **${title}**\n` +
      `Valor: *${brl}*\n\n` +
      'Pague escaneando o QR code abaixo.';

    if (transaction.qr_code_base64) {
      const buf = Buffer.from(transaction.qr_code_base64, 'base64');
      await ctx.replyWithPhoto(new InputFile(buf, 'pix.png'), {
        caption,
        parse_mode: 'Markdown',
      });
    } else if (transaction.qr_code) {
      await ctx.replyWithPhoto(transaction.qr_code, {
        caption,
        parse_mode: 'Markdown',
      });
    } else {
      await ctx.reply(`PIX criado: ${brl}\n\nCopie e cole: ${transaction.qr_code ?? 'indisponível'}`);
    }
  } catch (err) {
    ctx.logger.error({ err, downsellId }, '[DOWNSELL][PIX] erro ao gerar');
    await ctx.answerCallbackQuery({ text: 'Não consegui criar o PIX agora. Tente mais tarde.', show_alert: true });
  }
});


import { Composer } from 'grammy';
import type { MyContext } from '../../grammYContext.js';
import { createPixForDownsell } from '../../../services/bot/downsellsFlow.js';
import { sendPixUi } from '../../helpers/pixUi.js';

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
    const { transaction } = await createPixForDownsell({
      bot_slug: ctx.bot_slug!,
      telegram_id: ctx.from!.id,
      downsell_id: downsellId,
    });

    const username = ctx.from?.first_name ?? ctx.from?.username ?? undefined;

    await sendPixUi(ctx, transaction, {
      botSlug: ctx.bot_slug!,
      username,
    });
  } catch (err) {
    ctx.logger.error({ err, downsellId }, '[DOWNSELL][PIX] erro ao gerar');
    await ctx.answerCallbackQuery({ text: 'Não consegui criar o PIX agora. Tente mais tarde.', show_alert: true });
  }
});


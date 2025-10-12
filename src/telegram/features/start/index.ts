import { Composer } from 'grammy';
import { MyContext } from '../../grammYContext.js';
import { funnelService } from '../../../services/FunnelService.js';
import { mediaService } from '../../../services/MediaService.js';
import { startService } from './startService.js';
import { groupMediaForSending, type MediaAsset } from '../../../utils/mediaGrouping.js';
import { telegramMediaCache } from '../../../services/TelegramMediaCache.js';
import { buildPlansKeyboard } from '../../../services/bot/plans.js';
import { scheduleTriggeredDownsells } from '../../../services/bot/downsellsScheduler.js';
import { getSettings } from '../../../db/botSettings.js';

export const startFeature = new Composer<MyContext>();

startFeature.command('start', async (ctx) => {
  const botId = ctx.bot_id;
  const tgUserId = ctx.from?.id;

  if (!tgUserId) {
    return;
  }

  ctx.logger.info({ botSlug: ctx.bot_slug, tgUserId }, 'Received /start');

  try {
    // Upsert user
    await funnelService.upsertUser(botId, tgUserId);

    // Create start event
    const eventId = funnelService.generateStartEventId(botId, tgUserId);
    await funnelService.createEvent({
      bot_id: botId,
      tg_user_id: tgUserId,
      event: 'start',
      event_id: eventId,
    });

    // Get start template
    const template = await startService.getStartTemplate(botId);
    if (!template) {
      await ctx.reply('Olá! 👋');
      return;
    }

    const mediaAssets = await mediaService.getMediaByBotId(botId);

    if (mediaAssets.length > 0) {
      ctx.logger.info({ tgUserId, count: mediaAssets.length }, '[START][media] sending');
      await sendStartMediasFirst(ctx, mediaAssets, template.parse_mode ?? null);
    }

    // Envia múltiplas mensagens iniciais se houver start_messages
    const parseMode = template.parse_mode === 'HTML' ? 'HTML' : 'Markdown';
    const messages = template.start_messages && template.start_messages.length > 0
      ? template.start_messages
      : [template.text];

    ctx.logger.info({ tgUserId, messagesCount: messages.length }, '[START][text] sending');
    for (const message of messages) {
      if (!message || !message.trim()) {
        continue;
      }
      await ctx.reply(message, {
        parse_mode: parseMode,
      });
      // Pequeno delay entre mensagens para garantir ordem
      if (messages.length > 1) {
        await delay(100);
      }
    }

    try {
      const keyboard = await buildPlansKeyboard(ctx.bot_slug);
      if (keyboard) {
        const settings = await getSettings(ctx.bot_slug).catch(() => ({ bot_slug: ctx.bot_slug, pix_image_url: null, offers_text: null }));
        const offersText = settings?.offers_text?.trim() || 'Escolha uma oferta abaixo:';
        await ctx.reply(offersText, {
          reply_markup: keyboard,
        });
      }
    } catch (plansError) {
      ctx.logger.warn({ err: plansError }, '[START] failed to load plans');
    }

    ctx.logger.info({ tgUserId, eventId }, 'Start command completed');

    try {
      if (ctx.bot_slug && ctx.from?.id) {
        await scheduleTriggeredDownsells({
          bot_slug: ctx.bot_slug,
          telegram_id: ctx.from.id,
          trigger: 'after_start',
          logger: ctx.logger,
        });
      }
    } catch (err) {
      ctx.logger?.warn({ err }, '[DOWNSELL][AFTER_START] schedule failed');
    }
  } catch (err) {
    ctx.logger.error({ err, tgUserId }, 'Error handling /start command');
    await ctx.reply('Desculpe, ocorreu um erro. Por favor, tente novamente.');
  }
});

const VISUAL_SEND_DELAY_MS = 150;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendStartMediasFirst(
  ctx: MyContext,
  mediaAssets: MediaAsset[],
  templateParseMode: string | null
) {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    ctx.logger.warn({ tgUserId: ctx.from?.id }, 'Chat id missing for start command media sending');
    return;
  }

  const { albumAssets, audios } = groupMediaForSending(mediaAssets);

  if (audios.length > 0) {
    ctx.logger.info({ tgUserId: ctx.from?.id, count: audios.length }, '[START][media] audios');

    for (let index = 0; index < audios.length; index++) {
      const audio = audios[index];
      try {
        const sentMsg = await sendMediaWithCache(ctx, audio, chatId, templateParseMode ?? undefined);
        if (!audio.file_id && sentMsg?.audio) {
          await mediaService.updateFileId(audio.id, sentMsg.audio.file_id, sentMsg.audio.file_unique_id);
        }
      } catch (audioError) {
        ctx.logger.error({ err: audioError, tgUserId: ctx.from?.id, audioId: audio.id }, 'Error sending start audio');
      }
    }
  }

  if (albumAssets.length > 0) {
    ctx.logger.info({ tgUserId: ctx.from?.id, count: albumAssets.length }, '[START][media] visuals');

    try {
      for (let index = 0; index < albumAssets.length; index++) {
        const asset = albumAssets[index];
        if (!asset) {
          continue;
        }

        try {
          const sentMessage = await sendMediaWithCache(ctx, asset, chatId, templateParseMode ?? undefined);

          if (!asset.file_id && asset.kind === 'photo' && sentMessage?.photo) {
            const photo = sentMessage.photo[sentMessage.photo.length - 1];
            if (photo) {
              await mediaService.updateFileId(asset.id, photo.file_id, photo.file_unique_id);
            }
          } else if (!asset.file_id && asset.kind === 'video' && sentMessage?.video) {
            await mediaService.updateFileId(
              asset.id,
              sentMessage.video.file_id,
              sentMessage.video.file_unique_id
            );
          }
        } catch (visualError) {
          ctx.logger.error({ err: visualError, tgUserId: ctx.from?.id, assetId: asset.id }, 'Error sending start visual');
        }

        await delay(VISUAL_SEND_DELAY_MS);
      }
    } catch (mediaError) {
      ctx.logger.error({ err: mediaError, tgUserId: ctx.from?.id }, 'Error sending start media');
      await ctx.reply('⚠️ Não consegui carregar as mídias agora. Tente novamente em instantes.');
    }
  }
}

async function sendMediaWithCache(
  ctx: MyContext,
  asset: MediaAsset,
  chatId: number,
  parseMode?: string
) {
  const message = await telegramMediaCache.sendCached({
    token: ctx.bot_token,
    bot_slug: ctx.bot_slug,
    chat_id: chatId,
    item: {
      key: asset.id,
      type: asset.kind,
      source_url: asset.source_url,
      caption: null,
      parse_mode: parseMode ?? null,
      file_id: asset.file_id ?? undefined,
      file_unique_id: asset.file_unique_id ?? undefined,
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
      duration: asset.duration ?? undefined,
    },
  });

  return message as any;
}

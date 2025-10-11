import { Composer } from 'grammy';
import { MyContext } from '../../grammYContext.js';
import { funnelService } from '../../../services/FunnelService.js';
import { mediaService } from '../../../services/MediaService.js';
import { startService } from './startService.js';
import { groupMediaForSending } from '../../../utils/mediaGrouping.js';

export const startFeature = new Composer<MyContext>();

startFeature.command('start', async (ctx) => {
  const botId = ctx.bot_id;
  const tgUserId = ctx.from?.id;

  if (!tgUserId) {
    return;
  }

  ctx.logger.info({ tgUserId }, 'Received /start command');

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

    // Send text message
    await ctx.reply(template.text, {
      parse_mode: template.parse_mode === 'HTML' ? 'HTML' : 'Markdown',
    });

    // Get and send media
    const mediaAssets = await mediaService.getMediaByBotId(botId);
    if (mediaAssets.length > 0) {
      const { albumMedia, audios } = groupMediaForSending(mediaAssets);

      // Send album (photos + videos)
      if (albumMedia.length > 0) {
        const sentMessages = await ctx.replyWithMediaGroup(albumMedia);

        // Update file_ids for assets that were sent by URL
        for (let i = 0; i < sentMessages.length; i++) {
          const sentMsg = sentMessages[i];
          const asset = mediaAssets.find(a => a.kind === 'photo' || a.kind === 'video');
          
          if (asset && !asset.file_id) {
            if ('photo' in sentMsg && sentMsg.photo) {
              const photo = sentMsg.photo[sentMsg.photo.length - 1];
              await mediaService.updateFileId(asset.id, photo.file_id, photo.file_unique_id);
            } else if ('video' in sentMsg && sentMsg.video) {
              await mediaService.updateFileId(
                asset.id,
                sentMsg.video.file_id,
                sentMsg.video.file_unique_id
              );
            }
          }
        }
      }

      // Send audios separately
      for (const audio of audios) {
        const mediaInput = audio.file_id || audio.source_url || '';
        const sentMsg = await ctx.replyWithAudio(mediaInput, {
          duration: audio.duration || undefined,
        });

        // Update file_id if sent by URL
        if (!audio.file_id && 'audio' in sentMsg && sentMsg.audio) {
          await mediaService.updateFileId(
            audio.id,
            sentMsg.audio.file_id,
            sentMsg.audio.file_unique_id
          );
        }
      }
    }

    ctx.logger.info({ tgUserId, eventId }, 'Start command completed');
  } catch (err) {
    ctx.logger.error({ err, tgUserId }, 'Error handling /start command');
    await ctx.reply('Desculpe, ocorreu um erro. Por favor, tente novamente.');
  }
});

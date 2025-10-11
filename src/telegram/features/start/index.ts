import { Composer, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
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
      const { albumMedia, albumAssets, audios } = groupMediaForSending(mediaAssets);

      const chatId = ctx.chat?.id;
      if (!chatId) {
        ctx.logger.warn({ tgUserId }, 'Chat id missing for start command media sending');
        return;
      }

      const getFilenameFromUrl = (url: string | null, fallback: string) => {
        if (!url) {
          return fallback;
        }

        try {
          const parsed = new URL(url);
          const segments = parsed.pathname.split('/').filter(Boolean);
          if (segments.length > 0) {
            return decodeURIComponent(segments[segments.length - 1]);
          }
        } catch (error) {
          ctx.logger.debug({ error, url }, 'Failed to derive filename from url');
        }

        return fallback;
      };

      const toInputFile = async (assetUrl: string, fallbackName: string) => {
        const response = await fetch(assetUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch media ${assetUrl}: ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const filename = getFilenameFromUrl(assetUrl, fallbackName);
        return new InputFile(buffer, filename);
      };

      const resolveMediaInput = async (asset: typeof albumAssets[number], fallbackName: string) => {
        if (asset.file_id) {
          return asset.file_id;
        }

        if (asset.source_url) {
          return toInputFile(asset.source_url, fallbackName);
        }

        throw new Error(`Media asset ${asset.id} missing file_id and source_url`);
      };

      // Send album (photos + videos)
      if (albumMedia.length > 0) {
        try {
          const preparedMedia = await Promise.all(
            albumMedia.map(async (mediaItem, index) => {
              const asset = albumAssets[index];
              if (!asset) {
                return mediaItem;
              }

              const fallbackExtension = asset.kind === 'photo'
                ? 'jpg'
                : asset.kind === 'video'
                ? 'mp4'
                : 'dat';
              const fallbackName = `start-${asset.kind}-${index + 1}.${fallbackExtension}`;
              const mediaInput = await resolveMediaInput(asset, fallbackName);

              return {
                ...mediaItem,
                media: mediaInput,
              };
            })
          );

          let sentMessages: Message[] = [];

          if (
            preparedMedia.length === 1 &&
            preparedMedia[0].type === 'photo'
          ) {
            const [photoMedia] = preparedMedia;
            const message = await ctx.api.sendPhoto(chatId, photoMedia.media, {
              caption: photoMedia.caption,
              parse_mode: photoMedia.parse_mode,
              caption_entities: photoMedia.caption_entities,
              has_spoiler: photoMedia.has_spoiler,
              show_caption_above_media: photoMedia.show_caption_above_media,
            });
            sentMessages = [message];
          } else if (
            preparedMedia.length === 1 &&
            preparedMedia[0].type === 'video'
          ) {
            const [videoMedia] = preparedMedia;
            const message = await ctx.api.sendVideo(chatId, videoMedia.media, {
              caption: videoMedia.caption,
              parse_mode: videoMedia.parse_mode,
              caption_entities: videoMedia.caption_entities,
              has_spoiler: videoMedia.has_spoiler,
              show_caption_above_media: videoMedia.show_caption_above_media,
              duration: videoMedia.duration,
              width: videoMedia.width,
              height: videoMedia.height,
              supports_streaming: videoMedia.supports_streaming,
            });
            sentMessages = [message];
          } else {
            sentMessages = await ctx.api.sendMediaGroup(chatId, preparedMedia);
          }

          // Update file_ids for assets that were sent by URL
          for (let i = 0; i < sentMessages.length; i++) {
            const sentMsg = sentMessages[i];
            const asset = albumAssets[i];

            if (!asset || asset.file_id) {
              continue;
            }

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
        } catch (mediaError) {
          ctx.logger.error({ err: mediaError, tgUserId, botId }, 'Error sending start media');
          await ctx.reply('⚠️ Não consegui carregar as mídias agora. Tente novamente em instantes.');
        }
      }

      // Send audios separately
      for (let index = 0; index < audios.length; index++) {
        const audio = audios[index];
        try {
          const fallbackName = `start-audio-${index + 1}.mp3`;
          const mediaInput = audio.file_id
            ? audio.file_id
            : audio.source_url
            ? await toInputFile(audio.source_url, fallbackName)
            : null;

          if (!mediaInput) {
            throw new Error(`Audio asset ${audio.id} missing media source`);
          }

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
        } catch (audioError) {
          ctx.logger.error({ err: audioError, tgUserId, botId, audioId: audio.id }, 'Error sending start audio');
        }
      }
    }

    ctx.logger.info({ tgUserId, eventId }, 'Start command completed');
  } catch (err) {
    ctx.logger.error({ err, tgUserId }, 'Error handling /start command');
    await ctx.reply('Desculpe, ocorreu um erro. Por favor, tente novamente.');
  }
});

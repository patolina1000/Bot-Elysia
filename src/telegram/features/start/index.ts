import { Composer, InputFile } from 'grammy';
import { MyContext } from '../../grammYContext.js';
import { funnelService } from '../../../services/FunnelService.js';
import { mediaService } from '../../../services/MediaService.js';
import { startService } from './startService.js';
import { groupMediaForSending, type MediaAsset } from '../../../utils/mediaGrouping.js';

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

    const mediaAssets = await mediaService.getMediaByBotId(botId);

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

    const resolveMediaInput = async (
      asset: MediaAsset,
      fallbackName: string
    ) => {
      if (asset.file_id) {
        return asset.file_id;
      }

      if (asset.source_url) {
        return toInputFile(asset.source_url, fallbackName);
      }

      throw new Error(`Media asset ${asset.id} missing file_id and source_url`);
    };

    const mediaItems: StartMediaItem[] = mediaAssets.map((asset) => ({
      kind: asset.kind,
      url: asset.source_url,
      asset,
    }));

    if (mediaItems.length > 0) {
      ctx.logger.info({ tgUserId, count: mediaItems.length }, '[START][media] sending');
      await sendStartMediasFirst(ctx, mediaItems, resolveMediaInput);
    }

    const parseMode = template.parse_mode === 'HTML' ? 'HTML' : 'Markdown';
    ctx.logger.info({ tgUserId }, '[START][text] sending');
    await ctx.reply(template.text, {
      parse_mode: parseMode,
    });

    ctx.logger.info({ tgUserId, eventId }, 'Start command completed');
  } catch (err) {
    ctx.logger.error({ err, tgUserId }, 'Error handling /start command');
    await ctx.reply('Desculpe, ocorreu um erro. Por favor, tente novamente.');
  }
});

type StartMediaItem = {
  kind: 'photo' | 'video' | 'audio';
  url: string | null;
  asset: MediaAsset;
};

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) {
    return [arr];
  }

  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

async function sendStartMediasFirst(
  ctx: MyContext,
  mediaItems: StartMediaItem[],
  resolveMediaInput: (
    asset: MediaAsset,
    fallbackName: string
  ) => Promise<string | InputFile>
) {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    ctx.logger.warn({ tgUserId: ctx.from?.id }, 'Chat id missing for start command media sending');
    return;
  }

  const mediaAssets = mediaItems.map((item) => item.asset);
  const { albumMedia, albumAssets, audios } = groupMediaForSending(mediaAssets);

  if (audios.length > 0) {
    ctx.logger.info({ tgUserId: ctx.from?.id, count: audios.length }, '[START][media] audios');

    for (let index = 0; index < audios.length; index++) {
      const audio = audios[index];
      try {
        const fallbackName = `start-audio-${index + 1}.mp3`;
        const mediaInput = await resolveMediaInput(audio, fallbackName);

        const sentMsg = await ctx.api.sendAudio(chatId, mediaInput, {
          duration: audio.duration || undefined,
        });

        if (!audio.file_id && sentMsg.audio) {
          await mediaService.updateFileId(
            audio.id,
            sentMsg.audio.file_id,
            sentMsg.audio.file_unique_id
          );
        }
      } catch (audioError) {
        ctx.logger.error({ err: audioError, tgUserId: ctx.from?.id, audioId: audio.id }, 'Error sending start audio');
      }
    }
  }

  if (albumMedia.length > 0) {
    ctx.logger.info({ tgUserId: ctx.from?.id, count: albumMedia.length }, '[START][media] visuals');

    try {
      const visualEntries = albumMedia.map((mediaItem, index) => ({
        mediaItem,
        asset: albumAssets[index],
        visualIndex: index,
      }));

      const batches = chunk(visualEntries, 10);

      for (const batch of batches) {
        if (batch.length === 0) {
          continue;
        }

        if (batch.length === 1) {
          const [{ mediaItem, asset, visualIndex }] = batch;
          if (!asset) {
            continue;
          }

          const fallbackExtension = asset.kind === 'photo'
            ? 'jpg'
            : asset.kind === 'video'
            ? 'mp4'
            : 'dat';
          const fallbackName = `start-${asset.kind}-${visualIndex + 1}.${fallbackExtension}`;
          const mediaInput = await resolveMediaInput(asset, fallbackName);

          if (mediaItem.type === 'photo') {
            const sentMessage = await ctx.api.sendPhoto(chatId, mediaInput, {
              caption: mediaItem.caption,
              parse_mode: mediaItem.parse_mode,
              caption_entities: mediaItem.caption_entities,
              has_spoiler: mediaItem.has_spoiler,
              show_caption_above_media: mediaItem.show_caption_above_media,
            });

            if (!asset.file_id && sentMessage.photo) {
              const photo = sentMessage.photo[sentMessage.photo.length - 1];
              await mediaService.updateFileId(asset.id, photo.file_id, photo.file_unique_id);
            }
          } else {
            const sentMessage = await ctx.api.sendVideo(chatId, mediaInput, {
              caption: mediaItem.caption,
              parse_mode: mediaItem.parse_mode,
              caption_entities: mediaItem.caption_entities,
              has_spoiler: mediaItem.has_spoiler,
              show_caption_above_media: mediaItem.show_caption_above_media,
              duration: mediaItem.duration,
              width: mediaItem.width,
              height: mediaItem.height,
              supports_streaming: mediaItem.supports_streaming,
            });

            if (!asset.file_id && sentMessage.video) {
              await mediaService.updateFileId(
                asset.id,
                sentMessage.video.file_id,
                sentMessage.video.file_unique_id
              );
            }
          }

          continue;
        }

        const preparedBatch = await Promise.all(
          batch.map(async ({ mediaItem, asset, visualIndex }) => {
            if (!asset) {
              return { mediaPayload: mediaItem, asset };
            }

            const fallbackExtension = asset.kind === 'photo'
              ? 'jpg'
              : asset.kind === 'video'
              ? 'mp4'
              : 'dat';
            const fallbackName = `start-${asset.kind}-${visualIndex + 1}.${fallbackExtension}`;
            const mediaInput = await resolveMediaInput(asset, fallbackName);

            return {
              mediaPayload: {
                ...mediaItem,
                media: mediaInput,
              },
              asset,
            };
          })
        );

        const payload = preparedBatch.map((entry) => entry.mediaPayload);
        const sentMessages = await ctx.api.sendMediaGroup(chatId, payload);

        for (let i = 0; i < sentMessages.length; i++) {
          const sentMsg = sentMessages[i];
          const entry = preparedBatch[i];
          const asset = entry?.asset;

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
      }
    } catch (mediaError) {
      ctx.logger.error({ err: mediaError, tgUserId: ctx.from?.id }, 'Error sending start media');
      await ctx.reply('⚠️ Não consegui carregar as mídias agora. Tente novamente em instantes.');
    }
  }
}

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

const VISUAL_SEND_DELAY_MS = 150;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const { albumAssets, audios } = groupMediaForSending(mediaAssets);

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

  if (albumAssets.length > 0) {
    ctx.logger.info({ tgUserId: ctx.from?.id, count: albumAssets.length }, '[START][media] visuals');

    try {
      for (let index = 0; index < albumAssets.length; index++) {
        const asset = albumAssets[index];
        if (!asset) {
          continue;
        }

        const fallbackExtension = asset.kind === 'photo'
          ? 'jpg'
          : asset.kind === 'video'
          ? 'mp4'
          : 'dat';
        const fallbackName = `start-${asset.kind}-${index + 1}.${fallbackExtension}`;

        try {
          const mediaInput = await resolveMediaInput(asset, fallbackName);

          if (asset.kind === 'photo') {
            const sentMessage = await ctx.api.sendPhoto(chatId, mediaInput);

            if (!asset.file_id && sentMessage.photo) {
              const photo = sentMessage.photo[sentMessage.photo.length - 1];
              await mediaService.updateFileId(asset.id, photo.file_id, photo.file_unique_id);
            }
          } else if (asset.kind === 'video') {
            const sentMessage = await ctx.api.sendVideo(chatId, mediaInput, {
              duration: asset.duration || undefined,
              width: asset.width || undefined,
              height: asset.height || undefined,
              supports_streaming: true,
            });

            if (!asset.file_id && sentMessage.video) {
              await mediaService.updateFileId(
                asset.id,
                sentMessage.video.file_id,
                sentMessage.video.file_unique_id
              );
            }
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

import type { Bot } from 'grammy';
import type { MyContext } from '../../telegram/grammYContext.js';
import { logger } from '../../logger.js';
import { sendSafe } from '../../utils/telegramErrorHandler.js';
import type { MediaType } from '../../db/shotsQueue.js';

export interface ShotIntroPayload {
  bot_slug: string;
  copy: string;
  media_url: string | null;
  media_type: MediaType;
}

type CtxOrBot = Pick<MyContext, 'api'> | Bot<MyContext> | { api: any };

type SendResult = {
  mediaMessage: any | null;
  textMessages: any[];
  completed: boolean;
};

function resolveApi(ctxOrBot: CtxOrBot): any {
  if (ctxOrBot && typeof (ctxOrBot as any).api === 'object') {
    return (ctxOrBot as any).api;
  }
  throw new Error('ShotsMessageBuilder requires a context or bot instance with api');
}

function getChatAction(mediaType: MediaType):
  | 'upload_photo'
  | 'upload_video'
  | 'upload_audio'
  | 'upload_document'
  | null {
  switch (mediaType) {
    case 'photo':
      return 'upload_photo';
    case 'video':
      return 'upload_video';
    case 'audio':
      return 'upload_audio';
    case 'document':
      return 'upload_document';
    default:
      return null;
  }
}

export function splitShotCopy(copy: string, limit = 4096): string[] {
  if (!copy) {
    return [];
  }

  const normalised = copy.replace(/\r\n/g, '\n');
  const parts: string[] = [];
  let remaining = normalised;

  while (remaining.length > limit) {
    let chunkEnd = remaining.lastIndexOf('\n', limit);

    if (chunkEnd <= 0) {
      chunkEnd = limit;
    } else {
      chunkEnd = Math.min(chunkEnd + 1, limit);
    }

    parts.push(remaining.slice(0, chunkEnd));
    remaining = remaining.slice(chunkEnd);
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

export class ShotsMessageBuilder {
  static async sendShotIntro(
    ctxOrBot: CtxOrBot,
    chatId: number,
    shot: ShotIntroPayload
  ): Promise<SendResult> {
    const api = resolveApi(ctxOrBot);
    const copy = typeof shot.copy === 'string' ? shot.copy : '';
    const copyParts = splitShotCopy(copy, 4096);
    const mediaType = shot.media_url ? shot.media_type : 'none';

    logger.info(
      `[SHOTS][SEND][INTRO] chatId=${chatId} media=${mediaType} copyChars=${copy.length} parts=${copyParts.length}`
    );

    let mediaMessage: any | null = null;
    let completed = true;

    if (shot.media_url && mediaType !== 'none') {
      const action = getChatAction(mediaType);
      if (action) {
        await sendSafe(() => api.sendChatAction(chatId, action), shot.bot_slug, chatId);
      }

      const caption = copy && copy.length <= 1024 ? copy : undefined;
      const payloadOptions = caption
        ? { caption, parse_mode: 'HTML' as const }
        : undefined;

      if (mediaType === 'photo') {
        mediaMessage = await sendSafe(
          () => api.sendPhoto(chatId, shot.media_url, payloadOptions),
          shot.bot_slug,
          chatId
        );
      } else if (mediaType === 'video') {
        mediaMessage = await sendSafe(
          () => api.sendVideo(chatId, shot.media_url, payloadOptions),
          shot.bot_slug,
          chatId
        );
      } else if (mediaType === 'audio') {
        mediaMessage = await sendSafe(
          () => api.sendAudio(chatId, shot.media_url, payloadOptions),
          shot.bot_slug,
          chatId
        );
      } else if (mediaType === 'document') {
        mediaMessage = await sendSafe(
          () => api.sendDocument(chatId, shot.media_url, payloadOptions),
          shot.bot_slug,
          chatId
        );
      }

      if (mediaMessage === null) {
        return { mediaMessage, textMessages: [], completed: false };
      }
    }

    const textMessages: any[] = [];

    for (const part of copyParts) {
      if (!part) {
        continue;
      }

      const sent = await sendSafe(
        () =>
          api.sendMessage(chatId, part, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        shot.bot_slug,
        chatId
      );

      if (sent === null) {
        completed = false;
        break;
      }

      textMessages.push(sent);
    }

    return { mediaMessage, textMessages, completed };
  }
}

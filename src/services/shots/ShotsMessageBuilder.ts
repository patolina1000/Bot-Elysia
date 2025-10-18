import type { Bot } from 'grammy';
import type { MyContext } from '../../telegram/grammYContext.js';
import { logger } from '../../logger.js';
import { sendSafe } from '../../utils/telegramErrorHandler.js';
import type { MediaType } from '../../db/shotsQueue.js';
import type { ShotPlanRecord, ShotRecord } from '../../repositories/ShotsRepo.js';
import {
  buildDownsellKeyboard,
  formatPriceBRL,
} from '../../telegram/features/downsells/uiHelpers.js';

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

type SendPlansResult = {
  textMessages: any[];
  completed: boolean;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

  static async sendShotPlans(
    ctxOrBot: CtxOrBot,
    chatId: number,
    shot: Pick<ShotRecord, 'id' | 'bot_slug'> & { downsell_id?: number | null },
    plans: ShotPlanRecord[]
  ): Promise<SendPlansResult> {
    const api = resolveApi(ctxOrBot);
    const validPlans = Array.isArray(plans) ? plans : [];

    logger.info(
      `[SHOTS][SEND][PLANS] chatId=${chatId} plans=${validPlans.length}`
    );

    if (validPlans.length === 0) {
      return { textMessages: [], completed: true };
    }

    const planTexts: string[] = [];
    const buttonPlans: { label: string; price_cents: number }[] = [];

    for (const plan of validPlans) {
      const name = typeof plan?.name === 'string' ? plan.name.trim() : '';
      const description = typeof plan?.description === 'string' ? plan.description.trim() : '';
      const priceCents = Number(plan?.price_cents);

      if (name.length === 0) {
        continue;
      }

      const safeName = escapeHtml(name);
      const hasValidPrice = Number.isFinite(priceCents) && priceCents > 0;
      const priceLabel = hasValidPrice
        ? ` — R$ ${formatPriceBRL(Math.round(priceCents))}`
        : '';

      let block = `<b>${safeName}${priceLabel}</b>`;
      if (description.length > 0) {
        block += `\n${escapeHtml(description)}`;
      }

      planTexts.push(block);

      if (hasValidPrice) {
        buttonPlans.push({ label: name, price_cents: Math.round(priceCents) });
      }
    }

    if (planTexts.length === 0) {
      return { textMessages: [], completed: true };
    }

    const combinedText = planTexts.join('\n\n');
    const textParts = splitShotCopy(combinedText, 4096);

    const downsellId =
      typeof shot.downsell_id === 'number' && Number.isFinite(shot.downsell_id)
        ? shot.downsell_id
        : shot.id;

    const keyboard =
      buttonPlans.length > 0
        ? buildDownsellKeyboard(downsellId, {
            planLabel: buttonPlans[0]?.label ?? null,
            mainPriceCents: buttonPlans[0]?.price_cents ?? null,
            extraPlans: buttonPlans.slice(1),
          })
        : null;

    const textMessages: any[] = [];
    let completed = true;

    for (let index = 0; index < textParts.length; index += 1) {
      const part = textParts[index];
      if (!part) {
        continue;
      }

      const isLast = index === textParts.length - 1;
      const options: Record<string, unknown> = {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };

      if (isLast && keyboard) {
        options.reply_markup = keyboard;
      }

      const sent = await sendSafe(
        () =>
          api.sendMessage(chatId, part, options),
        shot.bot_slug,
        chatId
      );

      if (sent === null) {
        completed = false;
        break;
      }

      textMessages.push(sent);
    }

    return { textMessages, completed };
  }
}

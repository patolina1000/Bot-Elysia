import { logger } from '../../logger.js';
import { sendSafe } from '../../utils/telegramErrorHandler.js';
import type { ShotPlanRow, ShotRow } from '../../repositories/ShotsRepo.js';

type MediaMethod = 'sendPhoto' | 'sendVideo' | 'sendAudio' | 'sendDocument';
type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'upload_video'
  | 'upload_document'
  | 'record_video'
  | 'record_voice'
  | 'upload_voice'
  | 'choose_sticker'
  | 'find_location'
  | 'record_video_note'
  | 'upload_video_note';

type MediaSender = {
  chatAction: ChatAction;
  method: MediaMethod;
};

const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_TEXT_LIMIT = 4096;

function resolveTelegramId(chatId: number | string): number {
  if (typeof chatId === 'number' && Number.isFinite(chatId)) {
    return chatId;
  }

  const parsed = Number.parseInt(String(chatId), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeHtmlEntities(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function restoreSimpleTags(input: string): string {
  const simpleTags = ['b', 'i', 'u', 'code', 'pre'];
  let output = input;

  for (const tag of simpleTags) {
    const pattern = new RegExp(`&lt;(/?)${tag}&gt;`, 'gi');
    output = output.replace(pattern, (_, slash: string) => `<${slash ? '/' : ''}${tag}>`);
  }

  output = output.replace(
    /&lt;a\s+href=&quot;([^&]*)&quot;&gt;/gi,
    (_match, hrefEncoded: string) => {
      const decodedHref = hrefEncoded.replace(/&amp;/g, '&');
      if (!/^https?:\/\//i.test(decodedHref)) {
        return _match;
      }
      const safeHref = decodedHref.replace(/"/g, '%22');
      return `<a href="${safeHref}">`;
    }
  );

  output = output.replace(/&lt;\/a&gt;/gi, '</a>');

  return output;
}

export function sanitizeHtml(input: string): string {
  if (!input) {
    return '';
  }

  const escaped = escapeHtmlEntities(input);
  return restoreSimpleTags(escaped);
}

export function chunkText(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }

  const normalized = text.replace(/\r\n/g, '\n');
  const chunks: string[] = [];
  let remaining = normalized.trim();

  while (remaining.length > limit) {
    let breakIndex = remaining.lastIndexOf('\n\n', limit);
    if (breakIndex > -1) {
      breakIndex += 2;
    } else {
      breakIndex = remaining.lastIndexOf('\n', limit);
      if (breakIndex > -1) {
        breakIndex += 1;
      } else {
        breakIndex = remaining.lastIndexOf(' ', limit);
        if (breakIndex === -1) {
          breakIndex = limit;
        } else {
          breakIndex += 1;
        }
      }
    }

    const chunk = remaining.slice(0, breakIndex).trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    remaining = remaining.slice(breakIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export function formatBRL(cents: number): string {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
      (Number.isFinite(cents) ? cents : 0) / 100
    );
  } catch (err) {
    const value = (Number.isFinite(cents) ? cents : 0) / 100;
    return `R$ ${value.toFixed(2).replace('.', ',')}`;
  }
}

export function mapMediaSender(
  mediaType: ShotRow['media_type']
): MediaSender | null {
  switch (mediaType) {
    case 'photo':
      return { chatAction: 'upload_photo', method: 'sendPhoto' };
    case 'video':
      return { chatAction: 'upload_video', method: 'sendVideo' };
    case 'audio':
      return { chatAction: 'upload_voice', method: 'sendAudio' };
    case 'document':
      return { chatAction: 'upload_document', method: 'sendDocument' };
    default:
      return null;
  }
}

function isBadRequestError(err: unknown): boolean {
  const anyErr = err as { statusCode?: number; error_code?: number; response?: { error_code?: number } };
  const statusCode = anyErr?.statusCode ?? anyErr?.error_code ?? anyErr?.response?.error_code;
  return statusCode === 400;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

export interface BotLike {
  sendChatAction(chatId: number | string, action: ChatAction, ...args: any[]): Promise<any>;
  sendPhoto(chatId: number | string, media: any, ...args: any[]): Promise<any>;
  sendVideo(chatId: number | string, media: any, ...args: any[]): Promise<any>;
  sendAudio(chatId: number | string, media: any, ...args: any[]): Promise<any>;
  sendDocument(chatId: number | string, media: any, ...args: any[]): Promise<any>;
  sendMessage(chatId: number | string, text: string, ...args: any[]): Promise<any>;
}

export class ShotsMessageBuilder {
  static async sendShotIntro(
    bot: BotLike,
    chatId: number | string,
    shot: ShotRow,
    options?: { corr?: string }
  ): Promise<{ mediaMessageId?: number; textMessageIds: number[] }> {
    const telegramId = resolveTelegramId(chatId);
    const sanitizedCopy = sanitizeHtml(shot.copy ?? '');
    const mediaSender = mapMediaSender(shot.media_type ?? 'none');
    const hasMedia = Boolean(mediaSender && shot.media_url);
    const plainTextCopy = stripTags(sanitizedCopy).replace(/\s+/g, '');
    const copyLength = plainTextCopy.length;

    let captionUsed = false;
    let mediaMessageId: number | undefined;

    if (hasMedia && mediaSender) {
      const chatAction = mediaSender.chatAction;
      try {
        await bot.sendChatAction(chatId, chatAction);
      } catch (err) {
        logger.warn({ err, chatId, action: chatAction }, '[SHOTS][INTRO] failed to send chat action');
      }

      const shouldUseCaption = copyLength > 0 && copyLength <= TELEGRAM_CAPTION_LIMIT;
      const payloadOptions = shouldUseCaption
        ? { caption: sanitizedCopy, parse_mode: 'HTML', disable_web_page_preview: true }
        : undefined;
      try {
        const response = await sendSafe(
          () => (bot as any)[mediaSender.method](chatId, shot.media_url, payloadOptions),
          shot.bot_slug,
          telegramId
        );

        if (response === null) {
          return { textMessageIds: [] };
        }

        captionUsed = shouldUseCaption;
        mediaMessageId = Number(response?.message_id);
      } catch (err) {
        if (
          (mediaSender.method === 'sendPhoto' || mediaSender.method === 'sendVideo') &&
          isBadRequestError(err)
        ) {
          logger.warn(
            { err, chatId, mediaType: mediaSender.method },
            '[SHOTS][INTRO] media send failed, falling back to document'
          );

          const fallbackResponse = await sendSafe(
            () => bot.sendDocument(chatId, shot.media_url, payloadOptions),
            shot.bot_slug,
            telegramId
          );

          if (fallbackResponse === null) {
            return { textMessageIds: [] };
          }

          captionUsed = shouldUseCaption;
          mediaMessageId = Number(fallbackResponse?.message_id);
        } else {
          throw err;
        }
      }
    }

    const textMessageIds: number[] = [];
    const shouldSendText = copyLength > 0 && !captionUsed;
    const chunks = shouldSendText ? chunkText(sanitizedCopy, TELEGRAM_TEXT_LIMIT) : [];

    for (const part of chunks) {
      const response = await sendSafe(
        () =>
          bot.sendMessage(chatId, part, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        shot.bot_slug,
        telegramId
      );

      if (response === null) {
        break;
      }

      textMessageIds.push(Number(response.message_id));
    }

    const corrSuffix = options?.corr ? ` corr="${options.corr}"` : '';
    logger.info(
      `[SHOTS][SEND][INTRO] chatId=${chatId} media=${hasMedia ? shot.media_type ?? 'none' : 'none'} ` +
        `captionUsed=${captionUsed ? 'yes' : 'no'} copyChars=${copyLength} parts=${chunks.length}${corrSuffix}`
    );

    return { mediaMessageId, textMessageIds };
  }

  static async sendShotPlans(
    bot: BotLike,
    chatId: number | string,
    shot: ShotRow,
    plans: ShotPlanRow[],
    options?: { corr?: string }
  ): Promise<{ planMessageId?: number }> {
    const telegramId = resolveTelegramId(chatId);
    const validPlans = Array.isArray(plans) ? plans.filter((plan) => plan && plan.name?.trim()) : [];

    const corrSuffix = options?.corr ? ` corr="${options.corr}"` : '';
    logger.info(`[SHOTS][SEND][PLANS] chatId=${chatId} plans=${validPlans.length}${corrSuffix}`);

    if (validPlans.length === 0) {
      logger.info('[SHOTS][PLANS] none');
      return {};
    }

    const blocks: string[] = [];
    const buttonRows: { text: string; callback_data: string }[][] = [];
    let buttonIndex = 0;

    for (const plan of validPlans) {
      const nameHtml = sanitizeHtml(plan.name.trim());
      const descriptionHtml = plan.description ? sanitizeHtml(plan.description) : null;
      const priceCents = Number.isFinite(plan.price_cents) ? Math.max(0, Math.round(plan.price_cents)) : 0;
      const priceLabel = priceCents > 0 ? ` — ${formatBRL(priceCents)}` : '';

      let block = `• <b>${nameHtml}</b>${priceLabel}`;
      if (descriptionHtml) {
        block += `\n<i>${descriptionHtml}</i>`;
      }
      blocks.push(block);

      if (priceCents > 0) {
        const buttonText = `${stripTags(nameHtml)} — ${formatBRL(priceCents)}`;
        const callbackData = `downsell:${shot.id}:p${buttonIndex}`;
        buttonRows.push([{ text: buttonText, callback_data: callbackData }]);
        buttonIndex += 1;
      }
    }

    if (blocks.length === 0) {
      logger.info('[SHOTS][PLANS] none');
      return {};
    }

    const titlePrefix = shot.title ? `<b>${sanitizeHtml(shot.title)}</b>\n\n` : '';
    const messageBody = `${titlePrefix}${blocks.join('\n\n')}`.trim();
    const parts = chunkText(messageBody, TELEGRAM_TEXT_LIMIT);

    let planMessageId: number | undefined;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isLast = index === parts.length - 1;
      const options: Record<string, unknown> = {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };

      if (isLast && buttonRows.length > 0) {
        options.reply_markup = { inline_keyboard: buttonRows };
      }

      const response = await sendSafe(
        () => bot.sendMessage(chatId, part, options),
        shot.bot_slug,
        telegramId
      );

      if (response === null) {
        break;
      }

      planMessageId = Number(response.message_id);
    }

    return { planMessageId };
  }
}

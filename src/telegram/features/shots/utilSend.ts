import type { Bot } from 'grammy';
import type { Message, ParseMode } from 'grammy/types';

export type ChatId = Parameters<Bot['api']['sendMessage']>[0];

export interface SendableShot {
  media_type?: string | null;
  media_url?: string | null;
  message_text?: string | null;
  parse_mode?: string | null;
}

const SUPPORTED_PARSE_MODES: ParseMode[] = ['HTML', 'Markdown', 'MarkdownV2'];

function resolveParseMode(shot: SendableShot): ParseMode | undefined {
  const { parse_mode } = shot;
  if (typeof parse_mode !== 'string') {
    return 'HTML';
  }

  const trimmed = parse_mode.trim();
  if (!trimmed) {
    return 'HTML';
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === 'none' || lowered === 'plain') {
    return undefined;
  }

  const match = SUPPORTED_PARSE_MODES.find((mode) => mode.toLowerCase() === lowered);
  return match ?? 'HTML';
}

function resolveText(shot: SendableShot): string {
  const { message_text } = shot;
  return typeof message_text === 'string' ? message_text : '';
}

function resolveMediaUrl(shot: SendableShot): string | null {
  const { media_url } = shot;
  if (typeof media_url === 'string' && media_url.trim()) {
    return media_url;
  }
  return null;
}

export async function sendWithMedia(bot: Bot, chatId: ChatId, shot: SendableShot): Promise<Message> {
  const parseMode = resolveParseMode(shot);
  const text = resolveText(shot);
  const caption = text ? text : undefined;
  const mediaType = (shot.media_type ?? '').toLowerCase();
  const mediaUrl = resolveMediaUrl(shot);

  switch (mediaType) {
    case 'photo':
      if (!mediaUrl) break;
      return bot.api.sendPhoto(chatId, mediaUrl, { caption, parse_mode: parseMode });
    case 'video':
      if (!mediaUrl) break;
      return bot.api.sendVideo(chatId, mediaUrl, { caption, parse_mode: parseMode });
    case 'audio':
      if (!mediaUrl) break;
      return bot.api.sendAudio(chatId, mediaUrl, { caption, parse_mode: parseMode });
    case 'animation':
      if (!mediaUrl) break;
      return bot.api.sendAnimation(chatId, mediaUrl, { caption, parse_mode: parseMode });
    case 'text':
    default:
      break;
  }

  return bot.api.sendMessage(chatId, text, { parse_mode: parseMode });
}

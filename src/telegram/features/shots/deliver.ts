// Envio real de shots reutilizando os bots carregados no registry
// Mantemos os tipos "soltos" para não conflitar Telegraf/grammY.
import { getBotBySlug } from '../../botRegistry.js';

export type ShotHeader = {
  id: number;
  bot_slug: string;
  media_type: 'text' | 'photo' | 'video' | 'audio' | 'animation';
  message_text: string | null;
  media_url: string | null;
  parse_mode: string | null;
};

export async function deliverShot(header: ShotHeader, telegramId: string | number) {
  const bot: any = getBotBySlug(header.bot_slug);
  if (!bot) throw new Error(`Bot not found for slug ${header.bot_slug}`);
  // grammY usa bot.api.*; Telegraf usa bot.telegram.* — detectamos dinamicamente
  const api: any = bot.api ?? bot.telegram;
  if (!api) throw new Error(`Telegram API not available for ${header.bot_slug}`);

  const parseModeOpt = header.parse_mode ? { parse_mode: header.parse_mode } : {};
  const caption = header.message_text ?? undefined;

  switch (header.media_type) {
    case 'text': {
      const text = header.message_text ?? '';
      if (!text.trim()) throw new Error('message_text vazio para media_type=text');
      await api.sendMessage(telegramId, text, parseModeOpt);
      break;
    }
    case 'photo': {
      if (!header.media_url) throw new Error('media_url ausente para photo');
      await api.sendPhoto(telegramId, header.media_url, { ...parseModeOpt, caption });
      break;
    }
    case 'video': {
      if (!header.media_url) throw new Error('media_url ausente para video');
      await api.sendVideo(telegramId, header.media_url, { ...parseModeOpt, caption });
      break;
    }
    case 'audio': {
      if (!header.media_url) throw new Error('media_url ausente para audio');
      await api.sendAudio(telegramId, header.media_url, { ...parseModeOpt, caption });
      break;
    }
    case 'animation': {
      if (!header.media_url) throw new Error('media_url ausente para animation');
      await api.sendAnimation(telegramId, header.media_url, { ...parseModeOpt, caption });
      break;
    }
    default:
      throw new Error(`media_type inválido: ${header.media_type}`);
  }
}

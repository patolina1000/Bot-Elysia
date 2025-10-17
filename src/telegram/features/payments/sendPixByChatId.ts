import type { Api } from 'grammy';
import type { InlineKeyboardMarkup, Message } from '@grammyjs/types';
import type { PaymentTransaction } from '../../../db/payments.js';
import type { BotSettings } from '../../../db/botSettings.js';
import {
  buildPixEmvBlock,
  buildPixInstructionText,
  buildPixKeyboard,
  resolvePixMiniAppUrl,
} from './pixMessageParts.js';
import { sendSafe } from '../../../utils/telegramErrorHandler.js';

type TelegramMessageLike = Pick<Message, 'message_id'>;

export async function sendPixByChatId(
  chatId: number,
  tx: PaymentTransaction,
  settings: BotSettings,
  api: Api,
  baseUrl: string,
  bot_slug?: string
): Promise<{ message_ids: number[] }> {
  const sentIds: number[] = [];
  const slug = bot_slug ?? 'unknown';

  if (settings.pix_image_url) {
    const photoMsg = await sendSafe(
      () => api.sendPhoto(chatId, settings.pix_image_url!),
      slug,
      chatId
    ) as TelegramMessageLike | null;
    if (photoMsg && typeof photoMsg?.message_id === 'number') {
      sentIds.push(photoMsg.message_id);
    }
  }

  const instructionText = buildPixInstructionText(settings, tx);
  const copyMsg = await sendSafe(
    () => api.sendMessage(chatId, instructionText),
    slug,
    chatId
  ) as TelegramMessageLike | null;
  if (copyMsg && typeof copyMsg?.message_id === 'number') {
    sentIds.push(copyMsg.message_id);
  }

  const copyPrompt = await sendSafe(
    () => api.sendMessage(chatId, 'Copie o código abaixo:'),
    slug,
    chatId
  ) as TelegramMessageLike | null;
  if (copyPrompt && typeof copyPrompt?.message_id === 'number') {
    sentIds.push(copyPrompt.message_id);
  }

  const emvBlock = buildPixEmvBlock(tx);
  const emvMsg = await sendSafe(
    () => api.sendMessage(chatId, emvBlock, { parse_mode: 'HTML' }),
    slug,
    chatId
  ) as TelegramMessageLike | null;
  if (emvMsg && typeof emvMsg?.message_id === 'number') {
    sentIds.push(emvMsg.message_id);
  }

  const miniAppUrl = resolvePixMiniAppUrl(tx.external_id, baseUrl);
  const keyboard: InlineKeyboardMarkup = buildPixKeyboard({
    miniAppUrl,
    confirmCallbackData: `paid:${tx.external_id}`,
  });
  const kbMsg = await sendSafe(
    () => api.sendMessage(chatId, 'Após efetuar o pagamento, clique no botão abaixo ⤵️', {
      reply_markup: keyboard,
    }),
    slug,
    chatId
  ) as TelegramMessageLike | null;
  if (kbMsg && typeof kbMsg?.message_id === 'number') {
    sentIds.push(kbMsg.message_id);
  }

  return { message_ids: sentIds };
}

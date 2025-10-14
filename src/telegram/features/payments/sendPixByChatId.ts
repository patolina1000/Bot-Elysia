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

type TelegramMessageLike = Pick<Message, 'message_id'>;

export async function sendPixByChatId(
  chatId: number,
  tx: PaymentTransaction,
  settings: BotSettings,
  api: Api,
  baseUrl: string
): Promise<{ message_ids: number[] }> {
  const sentIds: number[] = [];

  if (settings.pix_image_url) {
    const photoMsg = (await api.sendPhoto(chatId, settings.pix_image_url)) as TelegramMessageLike;
    if (typeof photoMsg?.message_id === 'number') {
      sentIds.push(photoMsg.message_id);
    }
  }

  const instructionText = buildPixInstructionText(settings, tx);
  const copyMsg = (await api.sendMessage(chatId, instructionText)) as TelegramMessageLike;
  if (typeof copyMsg?.message_id === 'number') {
    sentIds.push(copyMsg.message_id);
  }

  const copyPrompt = (await api.sendMessage(chatId, 'Copie o código abaixo:')) as TelegramMessageLike;
  if (typeof copyPrompt?.message_id === 'number') {
    sentIds.push(copyPrompt.message_id);
  }

  const emvBlock = buildPixEmvBlock(tx);
  const emvMsg = (await api.sendMessage(chatId, emvBlock, { parse_mode: 'HTML' })) as TelegramMessageLike;
  if (typeof emvMsg?.message_id === 'number') {
    sentIds.push(emvMsg.message_id);
  }

  const miniAppUrl = resolvePixMiniAppUrl(tx.external_id, baseUrl);
  const keyboard: InlineKeyboardMarkup = buildPixKeyboard({
    miniAppUrl,
    confirmCallbackData: `paid:${tx.external_id}`,
  });
  const kbMsg = (await api.sendMessage(chatId, 'Após efetuar o pagamento, clique no botão abaixo ⤵️', {
    reply_markup: keyboard,
  })) as TelegramMessageLike;
  if (typeof kbMsg?.message_id === 'number') {
    sentIds.push(kbMsg.message_id);
  }

  return { message_ids: sentIds };
}

import type { Telegraf } from 'telegraf';
import type { PaymentTransaction } from '../../../db/payments.js';
import type { BotSettings } from '../../../db/botSettings.js';
import {
  buildPixEmvBlock,
  buildPixInstructionText,
  buildPixKeyboard,
} from './pixMessageParts.js';

interface TelegramMessageLike {
  message_id?: number;
}

export async function sendPixByChatId(
  chatId: number,
  tx: PaymentTransaction,
  settings: BotSettings,
  tg: Telegraf['telegram'],
  baseUrl: string
): Promise<{ message_ids: number[] }> {
  const sentIds: number[] = [];

  if (settings.pix_image_url) {
    const photoMsg = (await tg.sendPhoto(chatId, settings.pix_image_url)) as TelegramMessageLike;
    if (typeof photoMsg?.message_id === 'number') {
      sentIds.push(photoMsg.message_id);
    }
  }

  const instructionText = buildPixInstructionText(settings, tx);
  const copyMsg = (await tg.sendMessage(chatId, instructionText)) as TelegramMessageLike;
  if (typeof copyMsg?.message_id === 'number') {
    sentIds.push(copyMsg.message_id);
  }

  const copyPrompt = (await tg.sendMessage(chatId, 'Copie o código abaixo:')) as TelegramMessageLike;
  if (typeof copyPrompt?.message_id === 'number') {
    sentIds.push(copyPrompt.message_id);
  }

  const emvBlock = buildPixEmvBlock(tx);
  const emvMsg = (await tg.sendMessage(chatId, emvBlock, { parse_mode: 'HTML' })) as TelegramMessageLike;
  if (typeof emvMsg?.message_id === 'number') {
    sentIds.push(emvMsg.message_id);
  }

  const keyboard = buildPixKeyboard(tx.external_id, baseUrl);
  const kbMsg = (await tg.sendMessage(chatId, 'Após efetuar o pagamento, clique no botão abaixo ⤵️', {
    reply_markup: keyboard,
  })) as TelegramMessageLike;
  if (typeof kbMsg?.message_id === 'number') {
    sentIds.push(kbMsg.message_id);
  }

  return { message_ids: sentIds };
}

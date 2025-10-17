import { Composer } from 'grammy';
import { MyContext } from '../../grammYContext.js';
import { telegramContactsService } from '../../../services/TelegramContactsService.js';

export const chatMemberFeature = new Composer<MyContext>();

/**
 * Handle my_chat_member updates
 * This captures when users block/unblock the bot
 */
chatMemberFeature.on('my_chat_member', async (ctx) => {
  const botSlug = ctx.bot_slug;
  const telegramId = ctx.myChatMember?.from?.id;
  const newStatus = ctx.myChatMember?.new_chat_member?.status;
  const oldStatus = ctx.myChatMember?.old_chat_member?.status;

  if (!telegramId || !botSlug) {
    ctx.logger.warn('[CHAT_MEMBER] Missing telegram_id or bot_slug');
    return;
  }

  const username = ctx.myChatMember?.from?.username;
  const languageCode = ctx.myChatMember?.from?.language_code;
  const isPremium = ctx.myChatMember?.from?.is_premium;

  ctx.logger.info(
    {
      bot_slug: botSlug,
      telegram_id: telegramId,
      old_status: oldStatus,
      new_status: newStatus,
    },
    '[CHAT_MEMBER] Status change detected'
  );

  try {
    // User blocked the bot (status: kicked)
    if (newStatus === 'kicked') {
      await telegramContactsService.markAsBlocked(botSlug, telegramId);
      ctx.logger.info(
        { bot_slug: botSlug, telegram_id: telegramId },
        '[CHAT_MEMBER] User blocked the bot'
      );
      return;
    }

    // User unblocked or started the bot (status: member)
    if (newStatus === 'member' && oldStatus === 'kicked') {
      await telegramContactsService.markAsActive({
        bot_slug: botSlug,
        telegram_id: telegramId,
        username,
        language_code: languageCode,
        is_premium: isPremium,
      });
      ctx.logger.info(
        { bot_slug: botSlug, telegram_id: telegramId },
        '[CHAT_MEMBER] User unblocked the bot'
      );
      return;
    }

    // User started the bot for the first time
    if (newStatus === 'member') {
      await telegramContactsService.markAsActive({
        bot_slug: botSlug,
        telegram_id: telegramId,
        username,
        language_code: languageCode,
        is_premium: isPremium,
      });
      ctx.logger.info(
        { bot_slug: botSlug, telegram_id: telegramId },
        '[CHAT_MEMBER] User started the bot'
      );
    }
  } catch (err) {
    ctx.logger.error(
      { err, bot_slug: botSlug, telegram_id: telegramId },
      '[CHAT_MEMBER] Failed to update contact status'
    );
  }
});

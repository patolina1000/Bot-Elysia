import { logger } from '../logger.js';
import { telegramContactsService } from '../services/TelegramContactsService.js';

export interface TelegramError extends Error {
  error_code?: number;
  description?: string;
  response?: {
    error_code?: number;
    description?: string;
  };
}

/**
 * Handle Telegram API errors and update contact status accordingly
 * Returns true if the error was handled and should not be retried
 */
export async function handleTelegramSendError(
  err: unknown,
  bot_slug: string,
  telegram_id: number
): Promise<boolean> {
  const telegramErr = err as TelegramError;
  const errorCode = telegramErr.error_code ?? telegramErr.response?.error_code;
  const description = (telegramErr.description ?? telegramErr.response?.description ?? '').toLowerCase();

  logger.info(
    {
      bot_slug,
      telegram_id,
      error_code: errorCode,
      description: telegramErr.description ?? telegramErr.response?.description,
    },
    '[TELEGRAM][ERROR] Send error detected'
  );

  // 403 - Bot was blocked by the user
  if (errorCode === 403 && description.includes('blocked')) {
    try {
      await telegramContactsService.markAsBlocked(bot_slug, telegram_id);
      logger.info(
        { bot_slug, telegram_id },
        '[TELEGRAM][ERROR] User blocked bot, contact updated'
      );
    } catch (updateErr) {
      logger.error(
        { err: updateErr, bot_slug, telegram_id },
        '[TELEGRAM][ERROR] Failed to update contact as blocked'
      );
    }
    return true; // Don't retry
  }

  // 403 or 400 - User is deactivated (account deleted)
  if (
    (errorCode === 403 || errorCode === 400) &&
    (description.includes('deactivated') || description.includes('user not found'))
  ) {
    try {
      await telegramContactsService.markAsDeactivated(bot_slug, telegram_id);
      logger.info(
        { bot_slug, telegram_id },
        '[TELEGRAM][ERROR] User account deactivated, contact updated'
      );
    } catch (updateErr) {
      logger.error(
        { err: updateErr, bot_slug, telegram_id },
        '[TELEGRAM][ERROR] Failed to update contact as deactivated'
      );
    }
    return true; // Don't retry
  }

  // 429 - Rate limit (should retry with backoff)
  if (errorCode === 429) {
    const retryAfter = (telegramErr as any).parameters?.retry_after;
    logger.warn(
      { bot_slug, telegram_id, retry_after: retryAfter },
      '[TELEGRAM][ERROR] Rate limit hit'
    );
    return false; // Should retry
  }

  // Other errors - log but don't update contact status
  return false;
}

/**
 * Wrapper for bot.api.sendMessage with error handling
 */
export async function sendMessageSafe(
  api: any,
  chat_id: number,
  text: string,
  options: any,
  bot_slug: string
): Promise<any> {
  try {
    return await api.sendMessage(chat_id, text, options);
  } catch (err) {
    const shouldNotRetry = await handleTelegramSendError(err, bot_slug, chat_id);
    if (shouldNotRetry) {
      logger.info(
        { bot_slug, telegram_id: chat_id },
        '[TELEGRAM] Message send skipped due to contact status'
      );
      return null;
    }
    throw err; // Re-throw for other errors
  }
}

/**
 * Wrapper for bot.api.sendPhoto with error handling
 */
export async function sendPhotoSafe(
  api: any,
  chat_id: number,
  photo: string,
  options: any,
  bot_slug: string
): Promise<any> {
  try {
    return await api.sendPhoto(chat_id, photo, options);
  } catch (err) {
    const shouldNotRetry = await handleTelegramSendError(err, bot_slug, chat_id);
    if (shouldNotRetry) {
      logger.info(
        { bot_slug, telegram_id: chat_id },
        '[TELEGRAM] Photo send skipped due to contact status'
      );
      return null;
    }
    throw err;
  }
}

/**
 * Wrapper for bot.api.sendVideo with error handling
 */
export async function sendVideoSafe(
  api: any,
  chat_id: number,
  video: string,
  options: any,
  bot_slug: string
): Promise<any> {
  try {
    return await api.sendVideo(chat_id, video, options);
  } catch (err) {
    const shouldNotRetry = await handleTelegramSendError(err, bot_slug, chat_id);
    if (shouldNotRetry) {
      logger.info(
        { bot_slug, telegram_id: chat_id },
        '[TELEGRAM] Video send skipped due to contact status'
      );
      return null;
    }
    throw err;
  }
}

/**
 * Generic wrapper for any Telegram API send method
 */
export async function sendSafe<T = any>(
  sendFn: () => Promise<T>,
  bot_slug: string,
  telegram_id: number
): Promise<T | null> {
  try {
    return await sendFn();
  } catch (err) {
    const shouldNotRetry = await handleTelegramSendError(err, bot_slug, telegram_id);
    if (shouldNotRetry) {
      logger.info(
        { bot_slug, telegram_id },
        '[TELEGRAM] Send operation skipped due to contact status'
      );
      return null;
    }
    throw err;
  }
}

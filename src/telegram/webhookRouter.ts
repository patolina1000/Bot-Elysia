import { Router, Request, Response } from 'express';
import { botRegistry } from '../services/BotRegistry.js';
import { getOrCreateBotBySlug } from './botFactory.js';
import { logger } from '../logger.js';

export const webhookRouter = Router();

webhookRouter.post('/tg/:slug/webhook', async (req: Request, res: Response): Promise<void> => {
  const slug = req.params.slug;
  const update = req.body;
  const secretToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;

  const updateType =
    update && typeof update === 'object' ? Object.keys(update as Record<string, unknown>)[0] : undefined;
  logger.info({ slug, updateType }, '[WEBHOOK] incoming');

  try {
    const botConfig = await botRegistry.getBotBySlug(slug);

    if (!botConfig) {
      throw new Error('Bot not found');
    }

    if (!botConfig.enabled) {
      throw new Error('Bot is disabled');
    }

    if (!secretToken || secretToken !== botConfig.webhook_secret) {
      throw new Error('Invalid secret token');
    }

    const bot = await getOrCreateBotBySlug(slug);

    const updateObj = (update && typeof update === 'object' ? (update as Record<string, any>) : {}) ?? {};
    const callbackQuery = updateObj.callback_query ?? null;
    const messageFromCallback = callbackQuery?.message ?? null;
    const baseMessage = updateObj.message ?? messageFromCallback ?? null;
    const chatId = baseMessage?.chat?.id ?? null;
    const fromId = callbackQuery?.from?.id ?? baseMessage?.from?.id ?? null;
    const requestId = (req as any).id ?? req.requestId ?? null;

    logger.info(
      {
        bot_slug: slug,
        update_type: updateType,
        has_callback: Boolean(callbackQuery),
        callback_data: typeof callbackQuery?.data === 'string' ? callbackQuery.data : null,
        chat_id: chatId,
        from_id: fromId,
        request_id: requestId,
      },
      '[TG][UPDATE] inbound'
    );

    await bot.handleUpdate(update, { source: 'webhook' } as any);
  } catch (err) {
    logger.error({ slug, err }, 'Failed to handle update');
  }

  res.status(200).json({ ok: true });
});

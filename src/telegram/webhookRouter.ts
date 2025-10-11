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
    await bot.handleUpdate(update, { source: 'webhook' } as any);
  } catch (err) {
    logger.error({ slug, err }, 'Failed to handle update');
  }

  res.status(200).json({ ok: true });
});

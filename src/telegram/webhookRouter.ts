import { Router, Request, Response } from 'express';
import { Bot } from 'grammy';
import { MyContext } from './grammYContext.js';
import { botRegistry } from '../services/BotRegistry.js';
import { createBot } from './botFactory.js';
import { logger } from '../logger.js';

// Cache for bot instances
const botInstances = new Map<string, Bot<MyContext>>();

export const webhookRouter = Router();

webhookRouter.post('/tg/:botSlug/webhook', async (req: Request, res: Response): Promise<void> => {
  const { botSlug } = req.params;
  const secretToken = req.headers['x-telegram-bot-api-secret-token'] as string;

  try {
    // Get bot config
    const botConfig = await botRegistry.getBotBySlug(botSlug);

    if (!botConfig) {
      logger.warn({ botSlug }, 'Bot not found');
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    if (!botConfig.enabled) {
      logger.warn({ botSlug }, 'Bot is disabled');
      res.status(403).json({ error: 'Bot is disabled' });
      return;
    }

    // Validate secret token
    if (secretToken !== botConfig.webhook_secret) {
      logger.warn({ botSlug, secretToken }, 'Invalid secret token');
      res.status(403).json({ error: 'Invalid secret token' });
      return;
    }

    // Get or create bot instance
    let botInstance = botInstances.get(botConfig.id);
    if (!botInstance) {
      logger.info({ botId: botConfig.id, botSlug }, 'Creating new bot instance');
      botInstance = createBot(botConfig);
      botInstances.set(botConfig.id, botInstance);
    }

    // Handle the update
    await botInstance.handleUpdate(req.body);

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err, botSlug }, 'Error handling webhook');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export function invalidateBotInstance(botId: string) {
  botInstances.delete(botId);
  logger.info({ botId }, 'Bot instance invalidated');
}

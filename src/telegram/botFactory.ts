import { Bot } from 'grammy';
import { MyContext } from './grammYContext.js';
import { BotConfig } from '../services/BotRegistry.js';
import { logger as rootLogger } from '../logger.js';
import { pool } from '../db/pool.js';
import { startFeature } from './features/start/index.js';
import { funnelsFeature } from './features/funnels/index.js';
import { broadcastFeature } from './features/broadcast/index.js';
import { paymentsFeature } from './features/payments/index.js';

export function createBot(config: BotConfig): Bot<MyContext> {
  const bot = new Bot<MyContext>(config.token);

  // Inject custom context
  bot.use(async (ctx, next) => {
    ctx.bot_id = config.id;
    ctx.bot_slug = config.slug;
    ctx.logger = rootLogger.child({ bot_id: config.id, bot_slug: config.slug });
    ctx.db = pool;
    await next();
  });

  // Register features based on bot configuration
  if (config.features['core-start']) {
    bot.use(startFeature);
  }

  if (config.features['funnels']) {
    bot.use(funnelsFeature);
  }

  if (config.features['broadcast']) {
    bot.use(broadcastFeature);
  }

  if (config.features['payments']) {
    bot.use(paymentsFeature);
  }

  // Error handler
  bot.catch((err) => {
    rootLogger.error({ err, bot_id: config.id }, 'Bot error');
  });

  return bot;
}

import { createApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { pool } from './db/pool.js';
import { telegramMediaCache } from './services/TelegramMediaCache.js';
import { getLastSentByBot, profileSend } from './services/TelegramSendProfiler.js';
import { startDownsellWorker } from './telegram/features/downsells/dispatcher.js';
import { runShotsWorkerForever } from './telegram/features/shots/shotsWorker.js';
import { botRegistry } from './telegram/botRegistry.js';

const app = createApp();

telegramMediaCache.scheduleHourlyWarmup(logger);

const keepAliveInput = Number(process.env.TG_KEEPALIVE_SEC ?? '25');
const KEEPALIVE_SEC = Number.isFinite(keepAliveInput) && keepAliveInput > 0 ? keepAliveInput : 25;

function scheduleTelegramKeepAlive() {
  type BotTokenInfo = { slug: string; token: string };
  let cachedBots: BotTokenInfo[] = [];
  let lastBotsFetch = 0;
  const BOTS_CACHE_MS = 60_000;

  const loadBots = async (): Promise<BotTokenInfo[]> => {
    const now = Date.now();
    if (now - lastBotsFetch > BOTS_CACHE_MS || !cachedBots.length) {
      const bots = await telegramMediaCache.listBots();
      cachedBots = bots.map((bot) => ({ slug: bot.slug, token: bot.token }));
      lastBotsFetch = now;
    }
    return cachedBots;
  };

  const tick = async () => {
    try {
      const bots = await loadBots();
      const lastByBot = getLastSentByBot();
      const now = Date.now();

      for (const bot of bots) {
        const last = lastByBot.get(bot.slug) ?? 0;
        if (now - last <= KEEPALIVE_SEC * 1000) {
          continue;
        }

        try {
          await profileSend(
            { bot_slug: bot.slug, chat_id: '0', media_key: null, route: 'keepalive_ping' },
            () => telegramMediaCache.callTelegram('getMe', bot.token, {})
          );
          logger.info({ slug: bot.slug }, '[KEEPALIVE] ping ok');
        } catch (err) {
          logger.warn(
            { slug: bot.slug, err: err instanceof Error ? err.message : String(err) },
            '[KEEPALIVE] ping erro'
          );
        }
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        '[KEEPALIVE] loop erro'
      );
    }
  };

  const intervalMs = 5_000;
  const run = () => {
    void tick();
  };

  run();
  setInterval(run, intervalMs);
}

scheduleTelegramKeepAlive();

startDownsellWorker(app);

type ShotsWorkerGlobal = typeof globalThis & { __SHOTS_WORKER_STARTED__?: boolean };

function startShotsWorkerOnce() {
  const g = globalThis as ShotsWorkerGlobal;
  if (g.__SHOTS_WORKER_STARTED__) {
    return;
  }

  g.__SHOTS_WORKER_STARTED__ = true;
  logger.info('[SHOTS][WORKER] iniciando (sempre ligado)');

  void (async () => {
    try {
      await runShotsWorkerForever((slug) => botRegistry.get(slug));
    } catch (err) {
      logger.error({ err }, '[SHOTS][WORKER][FATAL] loop interrompido');
    }
  })();
}

void (async () => {
  try {
    await botRegistry.loadAllEnabledBots();
    startShotsWorkerOnce();
    logger.info('[SHOTS][WORKER] iniciado');
  } catch (err) {
    logger.error({ err }, '[SHOTS][WORKER] falha ao iniciar');
  }
})();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'Server started');
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Received shutdown signal');

  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      await pool.end();
      logger.info('Database pool closed');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

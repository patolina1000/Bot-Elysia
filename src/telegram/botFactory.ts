import { Bot } from 'grammy';
import { MyContext } from './grammYContext.js';
import { logger as rootLogger } from '../logger.js';
import { pool } from '../db/pool.js';
import { startFeature } from './features/start/index.js';
import { funnelsFeature } from './features/funnels/index.js';
import { broadcastFeature } from './features/broadcast/index.js';
import { paymentsFeature } from './features/payments/index.js';
import { downsellsFeature } from './features/downsells/index.js';
import { getEncryptionKey } from '../utils/crypto.js';
import { getBotPaymentGatewayConfig } from '../db/botPaymentConfigs.js';
import { listPlans } from '../db/plans.js';
import { resolvePixGateway } from '../services/payments/pixGatewayResolver.js';

type BotFeatures = Record<string, boolean>;

type BotRow = {
  id: string;
  slug: string;
  token_encrypted: Buffer;
  enabled: boolean;
  features: BotFeatures;
};

const botInstances = new Map<string, Bot<MyContext>>();

async function fetchBotRowBySlug(slug: string): Promise<BotRow> {
  const result = await pool.query(
    `SELECT
        b.id,
        b.slug,
        b.token_encrypted,
        b.enabled,
        COALESCE(
          json_object_agg(bf.key, bf.enabled)
          FILTER (WHERE bf.key IS NOT NULL),
          '{}'::json
        ) AS features
      FROM bots b
      LEFT JOIN bot_features bf ON bf.bot_id = b.id
      WHERE b.slug = $1
      GROUP BY b.id, b.slug, b.token_encrypted, b.enabled`,
    [slug]
  );

  if (result.rows.length === 0) {
    throw new Error(`Bot not found for slug ${slug}`);
  }

  const row = result.rows[0];

  const tokenEncrypted: Buffer = (() => {
    if (row.token_encrypted instanceof Buffer) {
      return row.token_encrypted;
    }

    if (typeof row.token_encrypted === 'string') {
      const isHex = row.token_encrypted.startsWith('\\x');
      const normalized = isHex ? row.token_encrypted.slice(2) : row.token_encrypted;
      return Buffer.from(normalized, isHex ? 'hex' : 'utf8');
    }

    return Buffer.from(row.token_encrypted);
  })();

  return {
    id: row.id,
    slug: row.slug,
    token_encrypted: tokenEncrypted,
    enabled: row.enabled,
    features:
      typeof row.features === 'object' && row.features !== null
        ? row.features
        : {},
  };
}

async function decryptBotToken(tokenEncrypted: Buffer, slug: string): Promise<string> {
  try {
    const decryptResult = await pool.query(
      `SELECT pgp_sym_decrypt($1::bytea, $2)::text AS token`,
      [tokenEncrypted, getEncryptionKey()]
    );

    const token = decryptResult.rows[0]?.token;
    if (!token) {
      throw new Error('Empty bot token after decryption');
    }

    return token;
  } catch (err) {
    rootLogger.error({ err, slug }, 'Failed to decrypt bot token');
    throw err;
  }
}

function registerBotFeatures(bot: Bot<MyContext>, config: BotRow, token: string) {
  const features = config.features ?? {};
  const botLogger = rootLogger.child({ bot_id: config.id, bot_slug: config.slug });

  bot.use(async (ctx, next) => {
    ctx.bot_id = config.id;
    ctx.bot_slug = config.slug;
    ctx.bot_token = token;
    ctx.logger = botLogger;
    ctx.db = pool;
    ctx.bot_features = features;
    await next();
  });

  const startEnabled = features['core-start'] !== false;
  if (startEnabled) {
    bot.use(startFeature);
  } else {
    botLogger.info('[BOOT] core-start disabled explicitly');
  }

  void (async () => {
    try {
      const [paymentConfig, plans] = await Promise.all([
        getBotPaymentGatewayConfig(config.slug),
        listPlans(config.slug).catch(() => []),
      ]);

      const paymentsEnabled = features['payments'] !== false;
      const hasGatewayConfig = Boolean(paymentConfig?.token);
      const hasPlans = plans.some((plan) => plan.is_active);

      botLogger.info(
        {
          bot_id: config.id,
          bot_slug: config.slug,
          features,
          payments_enabled: paymentsEnabled,
          plans_count: plans.length,
          active_plans: plans.filter((plan) => plan.is_active).length,
          gateway_token_masked: paymentConfig?.token
            ? `${String(paymentConfig.token).slice(0, 6)}…(len=${String(paymentConfig.token).length})`
            : null,
        },
        '[BOOT] features loaded'
      );

      if (!paymentsEnabled && (hasGatewayConfig || hasPlans)) {
        botLogger.warn({ bot_slug: config.slug }, '[PIX][CFG] payments_flag_off_but_config_present');
      }

      if (paymentsEnabled) {
        await resolvePixGateway(config.slug, botLogger).catch((err) => {
          botLogger.warn({ err }, '[PIX][CFG] failed to resolve gateway on boot');
        });
      }
    } catch (err) {
      botLogger.error({ err }, '[BOOT] failed to inspect payments config');
    }
  })();

  if (features['funnels']) {
    bot.use(funnelsFeature);
  }

  if (features['broadcast']) {
    bot.use(broadcastFeature);
  }

  if (features['payments'] !== false) {
    bot.use(paymentsFeature);
    bot.use(downsellsFeature);
  }

  bot.catch((err) => {
    rootLogger.error({ err, bot_id: config.id, bot_slug: config.slug }, 'Bot error');
  });
}

export async function getOrCreateBotBySlug(slug: string): Promise<Bot<MyContext>> {
  const cachedBot = botInstances.get(slug);
  if (cachedBot) {
    return cachedBot;
  }

  const logger = rootLogger.child({ bot_slug: slug });

  const botRow = await fetchBotRowBySlug(slug);
  if (!botRow.enabled) {
    throw new Error(`Bot ${slug} is disabled`);
  }

  const token = await decryptBotToken(botRow.token_encrypted, slug);

  const bot = new Bot<MyContext>(token);

  registerBotFeatures(bot, botRow, token);

  logger.info({ botId: botRow.id, botSlug: slug }, 'Creating new bot instance');

  await bot.init();

  botInstances.set(slug, bot);

  return bot;
}

export function invalidateBotInstanceBySlug(slug: string) {
  if (botInstances.delete(slug)) {
    rootLogger.info({ botSlug: slug }, 'Bot instance invalidated');
  }
}

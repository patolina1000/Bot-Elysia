import { pool } from './pool.js';
import { logger } from '../logger.js';

export interface BotPaymentGatewayConfig {
  bot_slug: string;
  provider: string | null;
  token: string | null;
  webhook_base: string | null;
  webhook_url: string | null;
  meta?: Record<string, unknown> | null;
}

function isUndefinedRelationError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return /relation "?bot_payment/i.test(err.message);
}

export async function getBotPaymentGatewayConfig(
  botSlug: string
): Promise<BotPaymentGatewayConfig | null> {
  try {
    const result = await pool.query(
      `SELECT bot_slug, provider, token, webhook_base, webhook_url, meta
         FROM bot_payment_configs
        WHERE bot_slug = $1
        LIMIT 1`,
      [botSlug]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      bot_slug: row.bot_slug,
      provider: row.provider ?? null,
      token: row.token ?? null,
      webhook_base: row.webhook_base ?? null,
      webhook_url: row.webhook_url ?? null,
      meta: row.meta ?? null,
    };
  } catch (err) {
    if (isUndefinedRelationError(err)) {
      logger.debug({ err, botSlug }, '[PIX][CFG] bot_payment_configs table missing');
      return null;
    }

    logger.error({ err, botSlug }, '[PIX][CFG] failed to load bot payment config');
    return null;
  }
}

export async function listBotPaymentGatewayConfigs(): Promise<BotPaymentGatewayConfig[]> {
  try {
    const result = await pool.query(
      `SELECT bot_slug, provider, token, webhook_base, webhook_url, meta
         FROM bot_payment_configs`
    );

    return result.rows.map((row) => ({
      bot_slug: row.bot_slug,
      provider: row.provider ?? null,
      token: row.token ?? null,
      webhook_base: row.webhook_base ?? null,
      webhook_url: row.webhook_url ?? null,
      meta: row.meta ?? null,
    }));
  } catch (err) {
    if (isUndefinedRelationError(err)) {
      logger.debug({ err }, '[PIX][CFG] bot_payment_configs table missing');
      return [];
    }

    logger.error({ err }, '[PIX][CFG] failed to list bot payment configs');
    return [];
  }
}

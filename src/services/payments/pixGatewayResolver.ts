import { logger } from '../../logger.js';
import { PushinPayGateway } from './PushinPayGateway.js';
import { getBotPaymentGatewayConfig } from '../../db/botPaymentConfigs.js';
import type { Logger } from '../../logger.js';

const resolutionCache = new Map<string, PixGatewayResolution>();

type ResolutionSource = 'db' | 'env_bot' | 'env_global' | null;

function sanitizeBaseUrl(base: string | null | undefined): string | null {
  if (!base) {
    return null;
  }
  return base.replace(/\/+$/, '');
}

function determineEnv(rawEnv?: string | null): 'production' | 'sandbox' {
  const normalized = (rawEnv ?? process.env.PUSHINPAY_ENV ?? '').toLowerCase();
  if (normalized === 'sandbox') {
    return 'sandbox';
  }
  if (normalized === 'production') {
    return 'production';
  }
  return String(process.env.NODE_ENV ?? '').toLowerCase() === 'production' ? 'production' : 'sandbox';
}

function formatTokenMasked(token: string | null): string | null {
  if (!token) {
    return null;
  }
  return `${token.slice(0, 6)}…(len=${token.length})`;
}

function computeWebhookUrl(base: string | null, botSlug: string, explicitUrl?: string | null): string | null {
  if (explicitUrl) {
    return explicitUrl;
  }
  const trimmed = sanitizeBaseUrl(base);
  if (!trimmed) {
    return null;
  }
  return `${trimmed}/webhooks/pushinpay/${encodeURIComponent(botSlug)}`;
}

export interface PixGatewayResolution {
  provider: 'PushinPay' | null;
  source: ResolutionSource;
  token: string | null;
  tokenMasked: string | null;
  gateway: PushinPayGateway | null;
  webhookBase: string | null;
  webhookUrl: string | null;
}

function resolveEnvToken(botSlug: string): { token: string | null; source: ResolutionSource } {
  const envKey = `PUSHINPAY_TOKEN__${botSlug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const botToken = process.env[envKey];
  if (botToken) {
    return { token: botToken, source: 'env_bot' };
  }
  const globalToken = process.env.PUSHINPAY_TOKEN ?? null;
  if (globalToken) {
    return { token: globalToken, source: 'env_global' };
  }
  return { token: null, source: null };
}

export async function resolvePixGateway(
  botSlug: string,
  parentLogger?: Logger
): Promise<PixGatewayResolution> {
  const cached = resolutionCache.get(botSlug);
  if (cached) {
    const cachedLogger = (parentLogger ?? logger).child({ bot_slug: botSlug });
    cachedLogger.info(
      {
        provider: cached.provider,
        source: cached.source,
        token_masked: cached.tokenMasked,
        cached: true,
      },
      '[PIX][CFG] gateway_resolved'
    );
    return cached;
  }

  const log = (parentLogger ?? logger).child({ bot_slug: botSlug });

  const dbConfig = await getBotPaymentGatewayConfig(botSlug);

  let provider: 'PushinPay' | null = null;
  let token: string | null = null;
  let source: ResolutionSource = null;
  let webhookBase: string | null = null;
  let webhookUrl: string | null = null;

  if (dbConfig && typeof dbConfig.provider === 'string') {
    const normalizedProvider = dbConfig.provider.toLowerCase();
    if (normalizedProvider === 'pushinpay') {
      provider = 'PushinPay';
      token = typeof dbConfig.token === 'string' && dbConfig.token.trim().length > 0 ? dbConfig.token : null;
      source = token ? 'db' : null;
      webhookBase = sanitizeBaseUrl(dbConfig.webhook_base ?? null);
      webhookUrl = computeWebhookUrl(webhookBase, botSlug, dbConfig.webhook_url ?? undefined);
    }
  }

  if (!token) {
    const envResolution = resolveEnvToken(botSlug);
    token = envResolution.token;
    if (token) {
      provider = 'PushinPay';
      source = envResolution.source;
      webhookBase = sanitizeBaseUrl(webhookBase ?? process.env.APP_BASE_URL ?? null);
      webhookUrl = computeWebhookUrl(webhookBase, botSlug, webhookUrl ?? undefined);
    }
  }

  const tokenMasked = formatTokenMasked(token);

  log.info(
    {
      provider,
      source,
      token_masked: tokenMasked,
    },
    '[PIX][CFG] gateway_resolved'
  );

  const finalWebhookBase = sanitizeBaseUrl(webhookBase ?? process.env.APP_BASE_URL ?? null);
  const finalWebhookUrl = computeWebhookUrl(finalWebhookBase, botSlug, webhookUrl ?? undefined);

  let gateway: PushinPayGateway | null = null;
  if (provider === 'PushinPay' && token) {
    gateway = new PushinPayGateway({
      token,
      env: determineEnv((dbConfig?.meta as any)?.env),
      webhookBase: finalWebhookBase,
    });
  }

  const resolution: PixGatewayResolution = {
    provider,
    source,
    token,
    tokenMasked,
    gateway,
    webhookBase: finalWebhookBase,
    webhookUrl: finalWebhookUrl,
  };

  resolutionCache.set(botSlug, resolution);

  return resolution;
}

export function invalidatePixGateway(botSlug: string): void {
  resolutionCache.delete(botSlug);
}

export function clearPixGatewayCache(): void {
  resolutionCache.clear();
}

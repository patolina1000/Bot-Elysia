import { botRegistry } from '../BotRegistry.js';
import { listPlans } from '../../db/plans.js';
import { resolvePixGateway } from './pixGatewayResolver.js';
import { pool } from '../../db/pool.js';

export interface PixMatcherInfo {
  type: 'prefix' | 'regex' | 'route';
  value: string;
}

export interface PixDiagResponse {
  bot_slug: string;
  payments_enabled: boolean;
  gateway_resolved: boolean;
  gateway_provider: string | null;
  gateway_source: string | null;
  token_masked: string | null;
  plans: { id: number; name: string; price_cents: number; is_active: boolean }[];
  callback_prefixes_expected: string[];
  webhook_url: string | null;
  matchers: PixMatcherInfo[];
}

const CALLBACK_PREFIXES = ['plan:', 'qr:', 'paid:'];
const MATCHERS: PixMatcherInfo[] = [
  { type: 'prefix', value: 'plan:' },
  { type: 'prefix', value: 'qr:' },
  { type: 'prefix', value: 'paid:' },
];

async function listBotSlugs(): Promise<string[]> {
  const result = await pool.query(`SELECT slug FROM bots ORDER BY slug ASC`);
  return result.rows.map((row) => String(row.slug));
}

export async function buildPixDiag(slug: string): Promise<PixDiagResponse | null> {
  const botConfig = await botRegistry.getBotBySlug(slug);
  if (!botConfig) {
    return null;
  }

  const paymentsEnabled = botConfig.features?.payments !== false;
  const [plans, gateway] = await Promise.all([
    listPlans(slug),
    resolvePixGateway(slug),
  ]);

  return {
    bot_slug: slug,
    payments_enabled: paymentsEnabled,
    gateway_resolved: Boolean(gateway.gateway),
    gateway_provider: gateway.provider,
    gateway_source: gateway.source,
    token_masked: gateway.tokenMasked,
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.plan_name,
      price_cents: plan.price_cents,
      is_active: plan.is_active,
    })),
    callback_prefixes_expected: CALLBACK_PREFIXES,
    webhook_url: gateway.webhookUrl,
    matchers: MATCHERS,
  };
}

export async function buildPixDiagForAll(): Promise<PixDiagResponse[]> {
  const slugs = await listBotSlugs();
  const diagnostics: PixDiagResponse[] = [];

  for (const slug of slugs) {
    const diag = await buildPixDiag(slug);
    if (diag) {
      diagnostics.push(diag);
    }
  }

  return diagnostics;
}

import { PixCreationParams, PaymentGateway, registerGateway } from './registry.js';

const PROD_URL = 'https://api.pushinpay.com.br';
const SANDBOX_URL = 'https://api-sandbox.pushinpay.com.br';

export interface PushinPayGatewayOptions {
  token: string;
  env?: 'production' | 'sandbox';
  webhookBase?: string | null;
}

export interface PushinPayPixResponse {
  id: string;
  status: string;
  value: number;
  qr_code?: string;
  qr_code_base64?: string;
  webhook_url?: string;
  [key: string]: unknown;
}

export interface PushinPayTransactionResponse {
  id: string;
  status: string;
  [key: string]: unknown;
}

export class PushinPayError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly responseBody?: unknown) {
    super(message);
    this.name = 'PushinPayError';
  }
}

async function parseResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class PushinPayGateway implements PaymentGateway {
  private readonly baseUrl: string;

  constructor(private readonly options: PushinPayGatewayOptions) {
    this.baseUrl = options.env === 'sandbox' ? SANDBOX_URL : PROD_URL;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async createPix(params: PixCreationParams): Promise<PushinPayPixResponse> {
    const valueCents = Number(params.value_cents);
    if (!Number.isFinite(valueCents) || valueCents < 50) {
      const err = new Error('Valor mínimo é 50 centavos.');
      (err as any).code = 'MIN_VALUE';
      throw err;
    }

    // Webhook específico por bot
    const botSlugPath = params.botSlug ? `/${params.botSlug}` : '';
    const webhookPath = params.webhookPath ?? `/webhooks/pushinpay${botSlugPath}`;
    const webhookUrl = this.options.webhookBase ? `${this.options.webhookBase}${webhookPath}` : undefined;

    const body: Record<string, unknown> = {
      value: Math.trunc(valueCents),
      split_rules: params.splitRules ?? [],
    };
    if (webhookUrl) {
      body.webhook_url = webhookUrl;
    }

    const response = await fetch(`${this.baseUrl}/api/pix/cashIn`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new PushinPayError(
        `PushinPay cashIn falhou: ${response.status} ${response.statusText}`,
        response.status,
        payload
      );
    }

    return payload as PushinPayPixResponse;
  }

  async getTransaction(externalId: string): Promise<PushinPayTransactionResponse> {
    const response = await fetch(`${this.baseUrl}/api/transactions/${encodeURIComponent(externalId)}`, {
      method: 'GET',
      headers: this.headers,
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new PushinPayError(
        `PushinPay consulta falhou: ${response.status} ${response.statusText}`,
        response.status,
        payload
      );
    }

    return payload as PushinPayTransactionResponse;
  }
}

export function createPushinPayGatewayFromEnv(): PushinPayGateway {
  const token = process.env.PUSHINPAY_TOKEN ?? process.env.ADMIN_API_TOKEN ?? null;
  if (!token) {
    throw new Error('Credencial da PushinPay ausente: defina PUSHINPAY_TOKEN (recomendado).');
  }

  const rawEnv = (process.env.PUSHINPAY_ENV ?? '').toLowerCase();
  const envOption: 'production' | 'sandbox' = rawEnv
    ? rawEnv === 'sandbox'
      ? 'sandbox'
      : 'production'
    : String(process.env.NODE_ENV ?? '').toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';

  const webhookBase = process.env.APP_BASE_URL ?? null;

  if (!process.env.PUSHINPAY_TOKEN && process.env.ADMIN_API_TOKEN) {
    console.warn(
      '[PushinPay] WARNING: usando ADMIN_API_TOKEN como token do gateway. Configure PUSHINPAY_TOKEN assim que possível.'
    );
  }

  return new PushinPayGateway({ token, env: envOption, webhookBase });
}

export function registerPushinPayGatewayFromEnv(): PushinPayGateway {
  const gateway = createPushinPayGatewayFromEnv();
  registerGateway('pushinpay', gateway);
  return gateway;
}

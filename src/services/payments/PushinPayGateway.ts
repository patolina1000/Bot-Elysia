import { PixCreationParams, PaymentGateway, registerGateway } from './registry.js';
import { logger } from '../../logger.js';
import {
  generatePixTraceId,
  maskToken,
  sanitizeHeaders,
  getQrCodePreview,
  getQrCodeBase64Length,
  createBodyPreview,
  calculateElapsedMs,
} from '../../utils/pixLogging.js';

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

    const pix_trace_id = generatePixTraceId(null, params.transaction_id);
    const startTime = Date.now();

    // Log request
    logger.child({
      op: 'create',
      provider: 'PushinPay',
      bot_slug: params.botSlug ?? null,
      telegram_id: params.telegram_id ?? null,
      payload_id: params.payload_id ?? null,
      transaction_id: params.transaction_id ?? null,
      price_cents: valueCents,
      pix_trace_id,
    }).info({
      headers_sanitized: sanitizeHeaders(this.headers as Record<string, string>),
      body_preview: createBodyPreview(body),
    }, '[PIX][CREATE] request');

    const response = await fetch(`${this.baseUrl}/api/pix/cashIn`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    const payload = await parseResponse(response);
    const elapsed_ms = calculateElapsedMs(startTime);

    if (!response.ok) {
      // Log error
      logger.child({
        op: 'create',
        provider: 'PushinPay',
        pix_trace_id,
      }).error({
        http_status: response.status,
        provider_error_code: (payload as any)?.code ?? (payload as any)?.error_code ?? null,
        provider_error_msg: (payload as any)?.message ?? (payload as any)?.error ?? response.statusText,
        elapsed_ms,
        raw_response_len: JSON.stringify(payload).length,
      }, '[PIX][ERROR] create failed');

      throw new PushinPayError(
        `PushinPay cashIn falhou: ${response.status} ${response.statusText}`,
        response.status,
        payload
      );
    }

    // Log success
    const typedPayload = payload as PushinPayPixResponse;
    const provider_id = typedPayload.id;
    const final_trace_id = generatePixTraceId(provider_id, params.transaction_id);

    logger.child({
      op: 'create',
      provider: 'PushinPay',
      pix_trace_id: final_trace_id,
    }).info({
      provider_id,
      status: typedPayload.status,
      qr_code_preview: getQrCodePreview(typedPayload.qr_code),
      qr_code_base64_len: getQrCodeBase64Length(typedPayload.qr_code_base64),
      elapsed_ms,
    }, '[PIX][CREATE] response');

    return typedPayload;
  }

  async getTransaction(externalId: string): Promise<PushinPayTransactionResponse> {
    const pix_trace_id = generatePixTraceId(externalId, null);
    const startTime = Date.now();

    // Log request
    logger.child({
      op: 'status',
      provider: 'PushinPay',
      provider_id: externalId,
      pix_trace_id,
    }).info({
      headers_sanitized: sanitizeHeaders(this.headers as Record<string, string>),
    }, '[PIX][STATUS] request');

    const response = await fetch(`${this.baseUrl}/api/transactions/${encodeURIComponent(externalId)}`, {
      method: 'GET',
      headers: this.headers,
    });

    const payload = await parseResponse(response);
    const elapsed_ms = calculateElapsedMs(startTime);

    if (!response.ok) {
      // Check for rate limit
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        logger.child({
          op: 'status',
          provider: 'PushinPay',
          pix_trace_id,
        }).warn({
          retry_in_s: retryAfter ? Number(retryAfter) : null,
          elapsed_ms,
        }, '[PIX][STATUS] rate-limited');
      } else {
        logger.child({
          op: 'status',
          provider: 'PushinPay',
          pix_trace_id,
        }).error({
          http_status: response.status,
          provider_error_code: (payload as any)?.code ?? (payload as any)?.error_code ?? null,
          provider_error_msg: (payload as any)?.message ?? (payload as any)?.error ?? response.statusText,
          elapsed_ms,
          raw_response_len: JSON.stringify(payload).length,
        }, '[PIX][ERROR] status failed');
      }

      throw new PushinPayError(
        `PushinPay consulta falhou: ${response.status} ${response.statusText}`,
        response.status,
        payload
      );
    }

    // Log success
    const typedPayload = payload as PushinPayTransactionResponse;
    logger.child({
      op: 'status',
      provider: 'PushinPay',
      pix_trace_id,
    }).info({
      provider_id: externalId,
      status: typedPayload.status,
      elapsed_ms,
    }, '[PIX][STATUS] response');

    return typedPayload;
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

import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { getGateway } from '../../services/payments/registry.js';
import {
  generatePixTraceId,
  getQrCodePreview,
  getQrCodeBase64Length,
  calculateTtcMs,
} from '../../utils/pixLogging.js';
import {
  PushinPayGateway,
  PushinPayError,
  registerPushinPayGatewayFromEnv,
} from '../../services/payments/PushinPayGateway.js';
import { insertOrUpdatePayment, setPaymentStatus } from '../../db/payments.js';
import { pool } from '../../db/pool.js';
import { getPlanById } from '../../db/plans.js';
import { authAdminMiddleware } from '../middleware/authAdmin.js';
import { setAsPaid as setDownsellAsPaid } from '../../db/downsellsSent.js';

const PUSHINPAY_NOTICE_HTML = `<div class="text-xs opacity-70 mt-3">\n  <strong>Aviso:</strong> A PUSHIN PAY atua exclusivamente como processadora de pagamentos e não possui qualquer responsabilidade pela entrega, suporte, conteúdo, qualidade ou cumprimento das obrigações relacionadas aos produtos ou serviços oferecidos pelo vendedor.\n</div>`;

let pushinpayConfigured = false;
try {
  registerPushinPayGatewayFromEnv();
  pushinpayConfigured = true;
  logger.info('[payments] PushinPay gateway registrado');
} catch (err) {
  logger.warn({ err }, '[payments] PushinPay gateway não configurado');
}

async function recordFunnelEvent(params: {
  event: string;
  eventId: string;
  telegramId?: number | null;
  transactionId?: string | null;
  priceCents?: number | null;
  payloadId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const result = await pool.query(
    `INSERT INTO funnel_events (bot_id, tg_user_id, event, event_id, price_cents, transaction_id, payload_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb))
     ON CONFLICT (event_id) DO NOTHING
     RETURNING *`,
    [
      null,
      params.telegramId ?? null,
      params.event,
      params.eventId,
      params.priceCents ?? null,
      params.transactionId ?? null,
      params.payloadId ?? null,
      params.meta ? JSON.stringify(params.meta) : '{}',
    ]
  );

  // Log apenas se foi inserido (não duplicado)
  if (result.rows.length > 0) {
    const pix_trace_id = generatePixTraceId(params.transactionId ?? null, null);
    const bot_slug = params.meta && 'bot_slug' in params.meta ? String(params.meta.bot_slug) : null;
    const provider = params.meta && 'gateway' in params.meta ? String(params.meta.gateway) : null;

    logger.child({
      op: 'funnel',
      provider,
      provider_id: params.transactionId ?? null,
      bot_slug,
      telegram_id: params.telegramId ?? null,
      payload_id: params.payloadId ?? null,
      pix_trace_id,
    }).info({
      event: params.event,
      event_id: params.eventId,
      price_cents: params.priceCents ?? null,
    }, `[PIX][FUNNEL] ${params.event}`);
  }
}

type RawTrackingRow = {
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  utm_content?: unknown;
  utm_term?: unknown;
  src?: unknown;
  sck?: unknown;
};

async function tryLoadUtmByPayload(payloadId?: string | null): Promise<RawTrackingRow | null> {
  if (!payloadId) {
    return null;
  }

  try {
    const check = await pool.query("select to_regclass('public.payload_tracking') as t");
    if (!check.rows[0] || !check.rows[0].t) {
      return null;
    }

    const result = await pool.query(
      `select utm_source, utm_medium, utm_campaign, utm_content, utm_term, src, sck
         from payload_tracking
        where payload_id = $1
        order by created_at desc nulls last
        limit 1`,
      [payloadId]
    );

    return result.rows[0] ?? null;
  } catch (err) {
    return null;
  }
}

function normalizeUtm(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const input = raw as Record<string, unknown>;
  const normalized: Record<string, string> = {};
  const map: Record<string, string> = {
    utm_source: 'utm_source',
    utm_medium: 'utm_medium',
    utm_campaign: 'utm_campaign',
    utm_content: 'utm_content',
    utm_term: 'utm_term',
    src: 'src',
    sck: 'sck',
  };

  for (const [sourceKey, targetKey] of Object.entries(map)) {
    const value = input[sourceKey];
    if (value === undefined || value === null) {
      continue;
    }

    const normalizedValue = String(value).trim().toLowerCase().replace(/\s+/g, '-');
    if (normalizedValue.length > 0) {
      normalized[targetKey] = normalizedValue;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export const pushinpayRouter = Router();

const createPixSchema = z.object({
  value_cents: z.number().int().min(50),
  telegram_id: z.number().int().optional(),
  payload_id: z.string().min(1).optional(),
  plan_name: z.string().min(1).optional(),
  meta: z.record(z.unknown()).optional(),
});

const createPixByPlanSchema = z.object({
  plan_id: z.coerce.number().int().positive(),
  telegram_id: z.coerce.number().int().optional(),
  payload_id: z.string().min(1).optional(),
});

pushinpayRouter.post(
  '/api/payments/pushinpay/cash-in',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = createPixSchema.parse(req.body ?? {});

      // Extrair botSlug do meta, se disponível
      const botSlug = body.meta && typeof body.meta === 'object' && 'botSlug' in body.meta
        ? String(body.meta.botSlug)
        : undefined;

      const pix_trace_id = generatePixTraceId(null, null);
      const reqLogger = (req as any).log ?? logger;

      // Log entrada
      reqLogger.info({
        route: '/api/payments/pushinpay/cash-in',
        op: 'create',
        bot_slug: botSlug ?? null,
        telegram_id: body.telegram_id ?? null,
        payload_id: body.payload_id ?? null,
        price_cents: body.value_cents,
        pix_trace_id,
        request_id: (req as any).id ?? null,
      }, '[PIX][CREATE] inbound');

      let gateway: PushinPayGateway;
      try {
        gateway = getGateway('pushinpay') as PushinPayGateway;
      } catch (err) {
        const message = pushinpayConfigured
          ? 'Gateway PushinPay indisponível'
          : 'Gateway PushinPay não configurado';
        reqLogger.error({
          op: 'create',
          provider: 'PushinPay',
          pix_trace_id,
          http_status: 503,
        }, '[PIX][ERROR] gateway unavailable');
        res.status(503).json({ error: message });
        return;
      }

      const pix = await gateway.createPix({
        value_cents: body.value_cents,
        splitRules: [],
        botSlug,
        telegram_id: body.telegram_id ?? null,
        payload_id: body.payload_id ?? null,
      });
      const responseValue = Number(pix.value);
      const valueCents = Number.isFinite(responseValue) ? Math.trunc(responseValue) : body.value_cents;

      const baseMeta: Record<string, unknown> =
        body.meta && typeof body.meta === 'object' ? { ...body.meta } : {};

      let trackingParameters = normalizeUtm(
        'trackingParameters' in baseMeta ? baseMeta.trackingParameters : undefined
      );

      if (!trackingParameters) {
        const utmRow = await tryLoadUtmByPayload(body.payload_id ?? null);
        trackingParameters = normalizeUtm(utmRow) ?? null;
      }

      if (trackingParameters) {
        baseMeta.trackingParameters = trackingParameters;
      }

      const saved = await insertOrUpdatePayment({
        gateway: 'pushinpay',
        external_id: pix.id,
        status: typeof pix.status === 'string' ? pix.status : 'created',
        value_cents: valueCents,
        qr_code: typeof pix.qr_code === 'string' ? pix.qr_code : null,
        qr_code_base64: typeof pix.qr_code_base64 === 'string' ? pix.qr_code_base64 : null,
        webhook_url: typeof pix.webhook_url === 'string' ? pix.webhook_url : null,
        telegram_id: body.telegram_id ?? null,
        payload_id: body.payload_id ?? null,
        plan_name: body.plan_name ?? null,
        meta: baseMeta,
      });

      const final_trace_id = generatePixTraceId(saved.external_id, saved.id);

      await recordFunnelEvent({
        event: 'pix_created',
        eventId: `pix:${saved.external_id}`,
        telegramId: body.telegram_id ?? null,
        transactionId: saved.external_id,
        priceCents: saved.value_cents,
        payloadId: body.payload_id ?? null,
        meta: { gateway: 'pushinpay' },
      });

      // Log sucesso
      reqLogger.info({
        op: 'create',
        provider: 'PushinPay',
        provider_id: saved.external_id,
        transaction_id: saved.id,
        status: saved.status,
        pix_trace_id: final_trace_id,
        qr_code_preview: getQrCodePreview(saved.qr_code),
        qr_code_base64_len: getQrCodeBase64Length(saved.qr_code_base64),
      }, '[PIX][CREATE] ok');

      res.status(201).json({
        id: saved.external_id,
        status: saved.status,
        value_cents: saved.value_cents,
        qr_code: saved.qr_code,
        qr_code_base64: saved.qr_code_base64,
        webhook_url: saved.webhook_url,
        notice_html: PUSHINPAY_NOTICE_HTML,
      });
    } catch (err) {
      const reqLogger = (req as any).log ?? logger;

      if (err instanceof z.ZodError) {
        reqLogger.warn({
          op: 'create',
          provider: 'PushinPay',
          http_status: 400,
          validation_errors: err.flatten(),
        }, '[PIX][ERROR] validation failed');
        res.status(400).json({ error: 'Payload inválido', details: err.flatten() });
        return;
      }

      if (err instanceof PushinPayError) {
        const httpStatus = err.httpStatus && err.httpStatus >= 400 ? err.httpStatus : 502;
        reqLogger.error({
          op: 'create',
          provider: 'PushinPay',
          http_status: httpStatus,
          provider_error_code: (err.responseBody as any)?.code ?? null,
          provider_error_msg: err.message,
        }, '[PIX][ERROR] cashIn failed');
        res.status(httpStatus).json({
          error: err.message,
          details: err.responseBody ?? null,
        });
        return;
      }

      const message = err instanceof Error ? err.message : 'Erro inesperado';
      reqLogger.error({ err, op: 'create' }, '[PIX][ERROR] unexpected');
      res.status(500).json({ error: message });
    }
  }
);

pushinpayRouter.post(
  '/api/payments/pushinpay/cash-in/by-plan',
  authAdminMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const parsedBody = createPixByPlanSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      const reqLogger = (req as any).log ?? logger;
      reqLogger.warn({
        op: 'create',
        route: '/api/payments/pushinpay/cash-in/by-plan',
        http_status: 400,
        validation_errors: parsedBody.error.flatten(),
      }, '[PIX][ERROR] validation failed');
      res.status(400).json({ error: 'Payload inválido', details: parsedBody.error.flatten() });
      return;
    }

    try {
      const plan = await getPlanById(parsedBody.data.plan_id);
      if (!plan || !plan.is_active) {
        res.status(404).json({ error: 'plano não encontrado ou inativo' });
        return;
      }

      const pix_trace_id = generatePixTraceId(null, null);
      const reqLogger = (req as any).log ?? logger;

      // Log entrada
      reqLogger.info({
        route: '/api/payments/pushinpay/cash-in/by-plan',
        op: 'create',
        bot_slug: plan.bot_slug ?? null,
        telegram_id: parsedBody.data.telegram_id ?? null,
        payload_id: parsedBody.data.payload_id ?? null,
        price_cents: plan.price_cents,
        plan_id: plan.id,
        pix_trace_id,
        request_id: (req as any).id ?? null,
      }, '[PIX][CREATE] inbound');

      let gateway: PushinPayGateway;
      try {
        gateway = getGateway('pushinpay') as PushinPayGateway;
      } catch (err) {
        const message = pushinpayConfigured
          ? 'Gateway PushinPay indisponível'
          : 'Gateway PushinPay não configurado';
        reqLogger.error({
          op: 'create',
          provider: 'PushinPay',
          pix_trace_id,
          http_status: 503,
        }, '[PIX][ERROR] gateway unavailable');
        res.status(503).json({ error: message });
        return;
      }

      const pix = await gateway.createPix({
        value_cents: plan.price_cents,
        splitRules: [],
        botSlug: plan.bot_slug,
        telegram_id: parsedBody.data.telegram_id ?? null,
        payload_id: parsedBody.data.payload_id ?? null,
      });
      const responseValue = Number(pix.value);
      const valueCents = Number.isFinite(responseValue) ? Math.trunc(responseValue) : plan.price_cents;

      const saved = await insertOrUpdatePayment({
        gateway: 'pushinpay',
        external_id: pix.id,
        status: typeof pix.status === 'string' ? pix.status : 'created',
        value_cents: valueCents,
        qr_code: typeof pix.qr_code === 'string' ? pix.qr_code : null,
        qr_code_base64: typeof pix.qr_code_base64 === 'string' ? pix.qr_code_base64 : null,
        webhook_url: typeof pix.webhook_url === 'string' ? pix.webhook_url : null,
        telegram_id: parsedBody.data.telegram_id ?? null,
        payload_id: parsedBody.data.payload_id ?? null,
        plan_name: plan.plan_name,
        meta: { planFromAdmin: true, bot_slug: plan.bot_slug },
      });

      const final_trace_id = generatePixTraceId(saved.external_id, saved.id);

      await recordFunnelEvent({
        event: 'pix_created',
        eventId: `pix:${saved.external_id}`,
        telegramId: parsedBody.data.telegram_id ?? null,
        transactionId: saved.external_id,
        priceCents: saved.value_cents,
        payloadId: parsedBody.data.payload_id ?? null,
        meta: { gateway: 'pushinpay', plan_id: plan.id },
      });

      // Log sucesso
      reqLogger.info({
        op: 'create',
        provider: 'PushinPay',
        provider_id: saved.external_id,
        transaction_id: saved.id,
        status: saved.status,
        pix_trace_id: final_trace_id,
        qr_code_preview: getQrCodePreview(saved.qr_code),
        qr_code_base64_len: getQrCodeBase64Length(saved.qr_code_base64),
      }, '[PIX][CREATE] ok');

      res.status(201).json({
        id: saved.external_id,
        status: saved.status,
        plan_name: plan.plan_name,
        value_cents: saved.value_cents,
        qr_code: saved.qr_code,
        qr_code_base64: saved.qr_code_base64,
        webhook_url: saved.webhook_url,
        notice_html: PUSHINPAY_NOTICE_HTML,
      });
    } catch (err) {
      const reqLogger = (req as any).log ?? logger;

      if (err instanceof PushinPayError) {
        const httpStatus = err.httpStatus && err.httpStatus >= 400 ? err.httpStatus : 502;
        reqLogger.error({
          op: 'create',
          provider: 'PushinPay',
          http_status: httpStatus,
          provider_error_code: (err.responseBody as any)?.code ?? null,
          provider_error_msg: err.message,
        }, '[PIX][ERROR] cashIn failed');
        res.status(httpStatus).json({
          error: err.message,
          details: err.responseBody ?? null,
        });
        return;
      }

      const message = err instanceof Error ? err.message : 'Erro inesperado';
      reqLogger.error({ err, op: 'create' }, '[PIX][ERROR] unexpected');
      res.status(500).json({ error: message });
    }
  }
);

pushinpayRouter.get(
  '/api/payments/pushinpay/transactions/:id',
  async (req: Request, res: Response): Promise<void> => {
    const provider_id = req.params.id;
    const pix_trace_id = generatePixTraceId(provider_id, null);
    const reqLogger = (req as any).log ?? logger;

    // Log entrada
    reqLogger.info({
      route: '/api/payments/pushinpay/transactions/:id',
      op: 'status',
      provider: 'PushinPay',
      provider_id,
      pix_trace_id,
      request_id: (req as any).id ?? null,
    }, '[PIX][STATUS] query');

    try {
      let gateway: PushinPayGateway;
      try {
        gateway = getGateway('pushinpay') as PushinPayGateway;
      } catch (err) {
        const message = pushinpayConfigured
          ? 'Gateway PushinPay indisponível'
          : 'Gateway PushinPay não configurado';
        reqLogger.error({
          op: 'status',
          provider: 'PushinPay',
          pix_trace_id,
          http_status: 503,
        }, '[PIX][ERROR] gateway unavailable');
        res.status(503).json({ error: message });
        return;
      }

      const transaction = await gateway.getTransaction(provider_id);

      // Log sucesso
      reqLogger.info({
        op: 'status',
        provider: 'PushinPay',
        provider_id,
        status: transaction.status,
        pix_trace_id,
      }, '[PIX][STATUS] ok');

      res.json(transaction);
    } catch (err) {
      if (err instanceof PushinPayError) {
        const httpStatus = err.httpStatus && err.httpStatus >= 400 ? err.httpStatus : 502;
        reqLogger.error({
          op: 'status',
          provider: 'PushinPay',
          provider_id,
          http_status: httpStatus,
          provider_error_code: (err.responseBody as any)?.code ?? null,
          provider_error_msg: err.message,
          pix_trace_id,
        }, '[PIX][ERROR] status failed');
        res.status(httpStatus).json({
          error: err.message,
          details: err.responseBody ?? null,
        });
        return;
      }

      const message = err instanceof Error ? err.message : 'Erro inesperado';
      reqLogger.error({ err, op: 'status', pix_trace_id }, '[PIX][ERROR] unexpected');
      res.status(500).json({ error: message });
    }
  }
);

export const pushinpayWebhookRouter = Router();

const webhookPayloadSchema = z.object({
  id: z.string(),
  status: z.string(),
  end_to_end_id: z.string().optional(),
  payer_name: z.string().optional(),
  payer_national_registration: z.string().optional(),
});

// Webhook específico por bot
pushinpayWebhookRouter.post(
  '/webhooks/pushinpay/:botSlug',
  async (req: Request, res: Response): Promise<void> => {
    const botSlug = req.params.botSlug;
    const reqLogger = (req as any).log ?? logger;

    const secretHeader = process.env.PUSHINPAY_WEBHOOK_HEADER;
    const secretValue = process.env.PUSHINPAY_WEBHOOK_SECRET;

    if (secretHeader && secretValue) {
      const received = req.get(secretHeader);
      if (received !== secretValue) {
        reqLogger.warn({
          op: 'webhook',
          provider: 'PushinPay',
          bot_slug: botSlug,
          http_status: 401,
        }, '[PIX][WEBHOOK] unauthorized');
        res.status(401).json({ error: 'invalid webhook secret' });
        return;
      }
    }

    const parsed = webhookPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reqLogger.warn({
        op: 'webhook',
        provider: 'PushinPay',
        bot_slug: botSlug,
        http_status: 400,
        validation_errors: parsed.error.flatten(),
      }, '[PIX][ERROR] webhook validation failed');
      res.status(400).json({ error: 'payload inválido', details: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;
    const pix_trace_id = generatePixTraceId(payload.id, null);

    // Log recebimento do webhook
    reqLogger.info({
      op: 'webhook',
      provider: 'PushinPay',
      bot_slug: botSlug,
      provider_id: payload.id,
      status_next: payload.status,
      raw_status: payload.status,
      pix_trace_id,
      request_id: (req as any).id ?? null,
    }, '[PIX][WEBHOOK] received');

    try {
      const updated = await setPaymentStatus('pushinpay', payload.id, payload.status, {
        end_to_end_id: payload.end_to_end_id ?? null,
        payer_name: payload.payer_name ?? null,
        payer_doc: payload.payer_national_registration ?? null,
      });

      if (!updated) {
        reqLogger.warn({
          op: 'webhook',
          provider: 'PushinPay',
          provider_id: payload.id,
          pix_trace_id,
        }, '[PIX][WEBHOOK] transaction not found locally');
      }

      if (updated && payload.status === 'paid') {
        const ttc_ms = calculateTtcMs(updated.created_at);
        const mergedMeta = {
          ...(typeof updated.meta === 'object' && updated.meta ? updated.meta : {}),
          gateway: 'pushinpay',
          ...(payload.end_to_end_id ? { end_to_end_id: payload.end_to_end_id } : {}),
        };

        reqLogger.info(
          {
            tx_id: updated.id,
            origin: (mergedMeta as Record<string, unknown>)?.origin ?? null,
            downsell_id: (mergedMeta as Record<string, unknown>)?.downsell_id ?? null,
            plan_label: (mergedMeta as Record<string, unknown>)?.plan_label ?? null,
            price_cents: (mergedMeta as Record<string, unknown>)?.price_cents ?? null,
          },
          '[WEBHOOK][PAID] transaction confirmed'
        );

        // Log pagamento confirmado
        reqLogger.info({
          op: 'webhook',
          provider: 'PushinPay',
          provider_id: payload.id,
          bot_slug: botSlug,
          telegram_id: updated.telegram_id ?? null,
          payload_id: updated.payload_id ?? null,
          transaction_id: updated.id,
          price_cents: updated.value_cents,
          status_next: 'paid',
          pix_trace_id,
          ttc_ms,
          end_to_end_id: payload.end_to_end_id ?? null,
        }, '[PIX][WEBHOOK] payment confirmed');

        await recordFunnelEvent({
          event: 'purchase',
          eventId: `pur:${updated.external_id}`,
          telegramId: updated.telegram_id ?? null,
          transactionId: updated.external_id,
          priceCents: updated.value_cents,
          payloadId: updated.payload_id ?? null,
          meta: mergedMeta,
        });

        const meta = (typeof updated.meta === 'object' && updated.meta ? updated.meta : {}) as Record<string, unknown>;
        if (
          meta?.origin === 'downsells' &&
          meta?.downsell_id !== undefined &&
          updated.telegram_id !== null &&
          updated.telegram_id !== undefined
        ) {
          const downsellIdNumber = Number(meta.downsell_id);
          const telegramIdNumber = Number(updated.telegram_id);
          if (!Number.isFinite(downsellIdNumber) || !Number.isFinite(telegramIdNumber)) {
            reqLogger.warn(
              {
                downsell_id: meta.downsell_id,
                telegram_id: updated.telegram_id,
              },
              '[DOWNSELL][METRICS] invalid identifiers for paid mark'
            );
          } else {
            try {
              await setDownsellAsPaid({
                downsell_id: downsellIdNumber,
                telegram_id: telegramIdNumber,
                paid_at: new Date(),
                bot_slug:
                  typeof meta.bot_slug === 'string'
                    ? meta.bot_slug
                    : typeof botSlug === 'string'
                    ? botSlug
                    : null,
              });
              reqLogger.info(
                {
                  downsell_id: meta.downsell_id,
                  plan_label: meta.plan_label ?? null,
                  price_cents: meta.price_cents ?? null,
                },
                '[DOWNSELL][METRICS] marked as paid'
              );
            } catch (markErr) {
              reqLogger.warn({ err: markErr }, '[DOWNSELL][METRICS] failed to mark downsell as paid');
            }
          }
        }

        if (process.env.UTMIFY_API_TOKEN) {
          try {
            const trackingParameters =
              typeof updated.meta === 'object' && updated.meta && 'trackingParameters' in updated.meta
                ? (updated.meta as Record<string, unknown>).trackingParameters
                : undefined;

            const orderPayload = {
              orderId: updated.external_id,
              platform: process.env.UTMIFY_PLATFORM ?? 'hotbotweb',
              paymentMethod: 'pix',
              status: 'approved',
              createdAt: updated.created_at.toISOString(),
              approvedDate: new Date().toISOString(),
              customer: { email: 'unknown@example.com' },
              products: [
                {
                  id: 'plan',
                  name: updated.plan_name ?? 'Plano',
                  quantity: 1,
                  priceInCents: updated.value_cents,
                },
              ],
              trackingParameters: trackingParameters ?? {},
              isTest: (process.env.PUSHINPAY_ENV ?? '').toLowerCase() === 'sandbox',
            };

            await fetch('https://api.utmify.com.br/api-credentials/orders', {
              method: 'POST',
              headers: {
                'x-api-token': process.env.UTMIFY_API_TOKEN,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify(orderPayload),
            });
          } catch (notifyErr) {
            reqLogger.warn({ err: notifyErr }, '[payments] falha ao notificar UTMify');
          }
        }
      }

      reqLogger.info({
        op: 'webhook',
        provider: 'PushinPay',
        pix_trace_id,
        http_status: 200,
      }, '[PIX][WEBHOOK] processed');

      res.json({ ok: true });
    } catch (err) {
      reqLogger.error({
        err,
        op: 'webhook',
        provider: 'PushinPay',
        provider_id: payload.id,
        pix_trace_id,
      }, '[PIX][ERROR] webhook processing failed');
      const message = err instanceof Error ? err.message : 'Erro inesperado';
      res.status(500).json({ error: message });
    }
  }
);

// Webhook global (fallback para compatibilidade com webhooks antigos)
pushinpayWebhookRouter.post(
  '/webhooks/pushinpay',
  async (req: Request, res: Response): Promise<void> => {
    const reqLogger = (req as any).log ?? logger;

    const secretHeader = process.env.PUSHINPAY_WEBHOOK_HEADER;
    const secretValue = process.env.PUSHINPAY_WEBHOOK_SECRET;

    if (secretHeader && secretValue) {
      const received = req.get(secretHeader);
      if (received !== secretValue) {
        reqLogger.warn({
          op: 'webhook',
          provider: 'PushinPay',
          bot_slug: null,
          http_status: 401,
        }, '[PIX][WEBHOOK] unauthorized');
        res.status(401).json({ error: 'invalid webhook secret' });
        return;
      }
    }

    const parsed = webhookPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reqLogger.warn({
        op: 'webhook',
        provider: 'PushinPay',
        bot_slug: null,
        http_status: 400,
        validation_errors: parsed.error.flatten(),
      }, '[PIX][ERROR] webhook validation failed');
      res.status(400).json({ error: 'payload inválido', details: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;
    const pix_trace_id = generatePixTraceId(payload.id, null);

    // Log recebimento do webhook
    reqLogger.info({
      op: 'webhook',
      provider: 'PushinPay',
      bot_slug: null,
      provider_id: payload.id,
      status_next: payload.status,
      raw_status: payload.status,
      pix_trace_id,
      request_id: (req as any).id ?? null,
    }, '[PIX][WEBHOOK] received');

    try {
      const updated = await setPaymentStatus('pushinpay', payload.id, payload.status, {
        end_to_end_id: payload.end_to_end_id ?? null,
        payer_name: payload.payer_name ?? null,
        payer_doc: payload.payer_national_registration ?? null,
      });

      if (!updated) {
        reqLogger.warn({
          op: 'webhook',
          provider: 'PushinPay',
          provider_id: payload.id,
          pix_trace_id,
        }, '[PIX][WEBHOOK] transaction not found locally');
      }

      if (updated && payload.status === 'paid') {
        const ttc_ms = calculateTtcMs(updated.created_at);
        const mergedMeta = {
          ...(typeof updated.meta === 'object' && updated.meta ? updated.meta : {}),
          gateway: 'pushinpay',
          ...(payload.end_to_end_id ? { end_to_end_id: payload.end_to_end_id } : {}),
        };

        reqLogger.info(
          {
            tx_id: updated.id,
            origin: (mergedMeta as Record<string, unknown>)?.origin ?? null,
            downsell_id: (mergedMeta as Record<string, unknown>)?.downsell_id ?? null,
            plan_label: (mergedMeta as Record<string, unknown>)?.plan_label ?? null,
            price_cents: (mergedMeta as Record<string, unknown>)?.price_cents ?? null,
          },
          '[WEBHOOK][PAID] transaction confirmed'
        );

        // Log pagamento confirmado
        const botSlug = typeof updated.meta === 'object' && updated.meta && 'bot_slug' in updated.meta
          ? String(updated.meta.bot_slug)
          : null;

        reqLogger.info({
          op: 'webhook',
          provider: 'PushinPay',
          provider_id: payload.id,
          bot_slug: botSlug,
          telegram_id: updated.telegram_id ?? null,
          payload_id: updated.payload_id ?? null,
          transaction_id: updated.id,
          price_cents: updated.value_cents,
          status_next: 'paid',
          pix_trace_id,
          ttc_ms,
          end_to_end_id: payload.end_to_end_id ?? null,
        }, '[PIX][WEBHOOK] payment confirmed');

        await recordFunnelEvent({
          event: 'purchase',
          eventId: `pur:${updated.external_id}`,
          telegramId: updated.telegram_id ?? null,
          transactionId: updated.external_id,
          priceCents: updated.value_cents,
          payloadId: updated.payload_id ?? null,
          meta: mergedMeta,
        });

        const meta = (typeof updated.meta === 'object' && updated.meta ? updated.meta : {}) as Record<string, unknown>;
        if (
          meta?.origin === 'downsells' &&
          meta?.downsell_id !== undefined &&
          updated.telegram_id !== null &&
          updated.telegram_id !== undefined
        ) {
          const downsellIdNumber = Number(meta.downsell_id);
          const telegramIdNumber = Number(updated.telegram_id);
          if (!Number.isFinite(downsellIdNumber) || !Number.isFinite(telegramIdNumber)) {
            reqLogger.warn(
              {
                downsell_id: meta.downsell_id,
                telegram_id: updated.telegram_id,
              },
              '[DOWNSELL][METRICS] invalid identifiers for paid mark'
            );
          } else {
            try {
              await setDownsellAsPaid({
                downsell_id: downsellIdNumber,
                telegram_id: telegramIdNumber,
                paid_at: new Date(),
                bot_slug: typeof meta.bot_slug === 'string' ? meta.bot_slug : null,
              });
              reqLogger.info(
                {
                  downsell_id: meta.downsell_id,
                  plan_label: meta.plan_label ?? null,
                  price_cents: meta.price_cents ?? null,
                },
                '[DOWNSELL][METRICS] marked as paid'
              );
            } catch (markErr) {
              reqLogger.warn({ err: markErr }, '[DOWNSELL][METRICS] failed to mark downsell as paid');
            }
          }
        }

        if (process.env.UTMIFY_API_TOKEN) {
          try {
            const trackingParameters =
              typeof updated.meta === 'object' && updated.meta && 'trackingParameters' in updated.meta
                ? (updated.meta as Record<string, unknown>).trackingParameters
                : undefined;

            const orderPayload = {
              orderId: updated.external_id,
              platform: process.env.UTMIFY_PLATFORM ?? 'hotbotweb',
              paymentMethod: 'pix',
              status: 'approved',
              createdAt: updated.created_at.toISOString(),
              approvedDate: new Date().toISOString(),
              customer: { email: 'unknown@example.com' },
              products: [
                {
                  id: 'plan',
                  name: updated.plan_name ?? 'Plano',
                  quantity: 1,
                  priceInCents: updated.value_cents,
                },
              ],
              trackingParameters: trackingParameters ?? {},
              isTest: (process.env.PUSHINPAY_ENV ?? '').toLowerCase() === 'sandbox',
            };

            await fetch('https://api.utmify.com.br/api-credentials/orders', {
              method: 'POST',
              headers: {
                'x-api-token': process.env.UTMIFY_API_TOKEN,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify(orderPayload),
            });
          } catch (notifyErr) {
            reqLogger.warn({ err: notifyErr }, '[payments] falha ao notificar UTMify');
          }
        }
      }

      reqLogger.info({
        op: 'webhook',
        provider: 'PushinPay',
        pix_trace_id,
        http_status: 200,
      }, '[PIX][WEBHOOK] processed');

      res.json({ ok: true });
    } catch (err) {
      reqLogger.error({
        err,
        op: 'webhook',
        provider: 'PushinPay',
        provider_id: payload.id,
        pix_trace_id,
      }, '[PIX][ERROR] webhook processing failed');
      const message = err instanceof Error ? err.message : 'Erro inesperado';
      res.status(500).json({ error: message });
    }
  }
);

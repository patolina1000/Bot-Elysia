import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { getGateway } from '../../services/payments/registry.js';
import {
  PushinPayGateway,
  PushinPayError,
  registerPushinPayGatewayFromEnv,
} from '../../services/payments/PushinPayGateway.js';
import { insertOrUpdatePayment, setPaymentStatus } from '../../db/payments.js';
import { pool } from '../../db/pool.js';

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
  await pool.query(
    `INSERT INTO funnel_events (bot_id, tg_user_id, event, event_id, price_cents, transaction_id, payload_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb))
     ON CONFLICT (event_id) DO NOTHING`,
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

pushinpayRouter.post(
  '/api/payments/pushinpay/cash-in',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = createPixSchema.parse(req.body ?? {});

      let gateway: PushinPayGateway;
      try {
        gateway = getGateway('pushinpay') as PushinPayGateway;
      } catch (err) {
        const message = pushinpayConfigured
          ? 'Gateway PushinPay indisponível'
          : 'Gateway PushinPay não configurado';
        res.status(503).json({ error: message });
        return;
      }

      const pix = await gateway.createPix({ value_cents: body.value_cents, splitRules: [] });
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

      await recordFunnelEvent({
        event: 'pix_created',
        eventId: `pix:${saved.external_id}`,
        telegramId: body.telegram_id ?? null,
        transactionId: saved.external_id,
        priceCents: saved.value_cents,
        payloadId: body.payload_id ?? null,
        meta: { gateway: 'pushinpay' },
      });

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
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Payload inválido', details: err.flatten() });
        return;
      }

      if (err instanceof PushinPayError) {
        res.status(err.httpStatus && err.httpStatus >= 400 ? err.httpStatus : 502).json({
          error: err.message,
          details: err.responseBody ?? null,
        });
        return;
      }

      const message = err instanceof Error ? err.message : 'Erro inesperado';
      res.status(500).json({ error: message });
    }
  }
);

pushinpayRouter.get(
  '/api/payments/pushinpay/transactions/:id',
  async (req: Request, res: Response): Promise<void> => {
    try {
      let gateway: PushinPayGateway;
      try {
        gateway = getGateway('pushinpay') as PushinPayGateway;
      } catch (err) {
        const message = pushinpayConfigured
          ? 'Gateway PushinPay indisponível'
          : 'Gateway PushinPay não configurado';
        res.status(503).json({ error: message });
        return;
      }

      const transaction = await gateway.getTransaction(req.params.id);
      res.json(transaction);
    } catch (err) {
      if (err instanceof PushinPayError) {
        res.status(err.httpStatus && err.httpStatus >= 400 ? err.httpStatus : 502).json({
          error: err.message,
          details: err.responseBody ?? null,
        });
        return;
      }

      const message = err instanceof Error ? err.message : 'Erro inesperado';
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

pushinpayWebhookRouter.post(
  '/webhooks/pushinpay',
  async (req: Request, res: Response): Promise<void> => {
    const secretHeader = process.env.PUSHINPAY_WEBHOOK_HEADER;
    const secretValue = process.env.PUSHINPAY_WEBHOOK_SECRET;

    if (secretHeader && secretValue) {
      const received = req.get(secretHeader);
      if (received !== secretValue) {
        res.status(401).json({ error: 'invalid webhook secret' });
        return;
      }
    }

    const parsed = webhookPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'payload inválido', details: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;

    try {
      const updated = await setPaymentStatus('pushinpay', payload.id, payload.status, {
        end_to_end_id: payload.end_to_end_id ?? null,
        payer_name: payload.payer_name ?? null,
        payer_doc: payload.payer_national_registration ?? null,
      });

      if (!updated) {
        logger.warn({ external_id: payload.id }, '[payments] transação PushinPay não encontrada localmente');
      }

      if (updated && payload.status === 'paid') {
        const mergedMeta = {
          ...(typeof updated.meta === 'object' && updated.meta ? updated.meta : {}),
          gateway: 'pushinpay',
          ...(payload.end_to_end_id ? { end_to_end_id: payload.end_to_end_id } : {}),
        };

        await recordFunnelEvent({
          event: 'purchase',
          eventId: `pur:${updated.external_id}`,
          telegramId: updated.telegram_id ?? null,
          transactionId: updated.external_id,
          priceCents: updated.value_cents,
          payloadId: updated.payload_id ?? null,
          meta: mergedMeta,
        });

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
            logger.warn({ err: notifyErr }, '[payments] falha ao notificar UTMify');
          }
        }
      }

      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, '[payments] erro ao processar webhook PushinPay');
      const message = err instanceof Error ? err.message : 'Erro inesperado';
      res.status(500).json({ error: message });
    }
  }
);

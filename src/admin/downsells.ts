import type { Express, Request, Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

type DownsellTrigger = 'after_start' | 'after_pix';
type DownsellMediaType = 'photo' | 'video' | 'audio';

type DownsellPayload = {
  bot_slug: string;
  plan_id?: number | null;
  price_cents?: number;
  price?: string | number;
  price_brl?: string | number;
  price_reais?: string | number;
  copy: string;
  media_url?: string | null;
  media_type?: DownsellMediaType | null;
  trigger: DownsellTrigger;
  sort_order?: number | null;
  active?: boolean | null;
  delay_minutes?: number | null;
};

type BotPlanRow = {
  id: number;
  bot_slug: string;
  name: string;
  price_cents: number | null;
  is_active: boolean | null;
};

function sanitizeStr(value: unknown, max = 5000): string {
  const str = String(value ?? '').trim();
  return str.length > max ? str.slice(0, max) : str;
}

function parsePriceToCents(value: unknown): number {
  if (value === null || value === undefined) {
    return Number.NaN;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return Number.NaN;
  }

  const cleaned = trimmed.replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
  if (!cleaned) {
    return Number.NaN;
  }

  const hasComma = cleaned.includes(',');
  let normalized = cleaned.replace(',', '.');

  if (hasComma) {
    normalized = normalized.replace(/\.(?=.*\.)/g, '');
  } else {
    const parts = normalized.split('.');
    if (parts.length > 2) {
      const decimals = parts.pop() ?? '';
      normalized =
        parts.join('') +
        (decimals.length > 2 ? decimals : decimals ? `.${decimals}` : '');
    }
  }

  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round(number * 100) : Number.NaN;
}

function normalizeMediaType(value: unknown): DownsellMediaType | null {
  if (value === null || value === undefined) {
    return null;
  }
  const str = sanitizeStr(value, 16);
  return ['photo', 'video', 'audio'].includes(str)
    ? (str as DownsellMediaType)
    : null;
}

function normalizeTrigger(value: unknown): DownsellTrigger {
  const str = sanitizeStr(value ?? '', 32);
  return str === 'after_pix' ? 'after_pix' : 'after_start';
}

function normalizePlanId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function wasPriceProvided(payload: Partial<DownsellPayload> & Record<string, unknown>): boolean {
  const inputs = [payload.price_cents, payload.price, payload.price_brl, payload.price_reais];
  return inputs.some((value) => {
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }
    return true;
  });
}

async function findActivePlanForBot(planId: number, botSlug: string): Promise<BotPlanRow | null> {
  const { rows } = await pool.query<BotPlanRow>(
    `SELECT id, bot_slug, name, price_cents, is_active
       FROM bot_plans
      WHERE id = $1
        AND bot_slug = $2
      LIMIT 1`,
    [planId, botSlug]
  );

  const plan = rows[0];
  if (!plan) {
    return null;
  }

  if (plan.is_active === false) {
    return null;
  }

  return plan;
}

function clampDelayMinutes(value: unknown, fallback = 0): number {
  let delay = typeof value === 'number' ? value : Number(value ?? fallback);
  if (!Number.isFinite(delay) || delay < 0) {
    delay = fallback;
  }
  if (delay > 10080) {
    delay = 10080;
  }
  return Math.round(delay);
}

function normalizeSortOrder(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeActive(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function computePriceCents(payload: Partial<DownsellPayload>): number {
  let priceCents = Number.isFinite(payload?.price_cents as number)
    ? Number(payload!.price_cents)
    : Number.NaN;

  if (!Number.isFinite(priceCents)) {
    const fallbackSource = payload as {
      price?: unknown;
      price_brl?: unknown;
      price_reais?: unknown;
    };
    const rawReais =
      fallbackSource?.price ??
      fallbackSource?.price_brl ??
      fallbackSource?.price_reais ??
      null;
    if (rawReais !== null && rawReais !== undefined) {
      const parsed = parsePriceToCents(rawReais);
      if (Number.isFinite(parsed)) {
        priceCents = parsed;
      }
    }
  }

  return priceCents;
}

async function ensureDownsellSchema(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_downsells (
        id           bigserial PRIMARY KEY,
        bot_slug     text NOT NULL,
        price_cents  integer NOT NULL CHECK (price_cents >= 0),
        copy         text NOT NULL,
        media_url    text,
        media_type   text,
        trigger      text NOT NULL CHECK (trigger IN ('after_start','after_pix')),
        delay_minutes integer NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0 AND delay_minutes <= 10080),
        sort_order   integer DEFAULT 0,
        active       boolean DEFAULT true,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        -- remover índice único antigo, se existir
        IF EXISTS (
          SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_bot_downsells_bot_slug_sort'
        ) THEN
          EXECUTE 'DROP INDEX public.ux_bot_downsells_bot_slug_sort';
        END IF;
        -- criar índice normal (não-único) para acelerar ordenação/consulta
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ix_bot_downsells_bot_slug_sort'
        ) THEN
          CREATE INDEX ix_bot_downsells_bot_slug_sort ON bot_downsells(bot_slug, sort_order);
        END IF;
        -- compat: cria a coluna se não existir
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='bot_downsells' AND column_name='delay_minutes'
        ) THEN
          EXECUTE 'ALTER TABLE bot_downsells
                   ADD COLUMN delay_minutes integer NOT NULL DEFAULT 0';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='bot_downsells' AND column_name='plan_id'
        ) THEN
          EXECUTE 'ALTER TABLE bot_downsells
                   ADD COLUMN plan_id integer NULL';
        END IF;
      END$$;
    `);
  } catch (err) {
    logger.error({ err }, '[ADMIN][DOWNSELLS] Failed to ensure schema');
    throw err;
  }
}

export function registerAdminDownsellsRoutes(app: Express): void {
  void ensureDownsellSchema().catch((err) => {
    logger.error({ err }, '[ADMIN][DOWNSELLS] Schema initialization error');
  });

  app.post(
    '/admin/api/downsells',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const payload = req.body as Partial<DownsellPayload> & Record<string, unknown>;

        const botSlug = sanitizeStr(payload.bot_slug, 200).toLowerCase();
        const planId = normalizePlanId(payload.plan_id ?? (payload as { planId?: unknown }).planId);
        const copy = sanitizeStr(payload.copy, 8000);
        const mediaUrl = payload.media_url ? sanitizeStr(payload.media_url, 2000) : null;
        const mediaType = normalizeMediaType(payload.media_type);
        const rawTrigger = payload.trigger ?? (payload as { moment?: unknown })?.moment;
        const trigger = normalizeTrigger(rawTrigger);
        const priceCandidate = computePriceCents(payload);
        const priceProvided = wasPriceProvided(payload);
        const hasFinitePrice = Number.isFinite(priceCandidate);
        const priceCents = hasFinitePrice ? Number(priceCandidate) : null;
        const sortOrder = normalizeSortOrder(payload.sort_order);
        const delayMinutes = clampDelayMinutes(payload.delay_minutes);
        const active = normalizeActive(payload.active);

        if (!botSlug) {
          return res.status(400).json({ ok: false, error: 'bot_slug obrigatório' });
        }

        let plan: BotPlanRow | null = null;
        if (planId !== null) {
          plan = await findActivePlanForBot(planId, botSlug);
          if (!plan) {
            return res.status(400).json({ ok: false, error: 'plan_id inválido para este bot' });
          }
        }

        if (!copy) {
          return res.status(400).json({ ok: false, error: 'copy obrigatória' });
        }
        if (!plan) {
          if (!hasFinitePrice || (priceCents ?? 0) < 0) {
            return res.status(400).json({
              ok: false,
              error: "price inválido: envie price_cents (centavos) ou price (reais, ex: 19,90)",
            });
          }
        } else if (priceProvided) {
          if (!hasFinitePrice || (priceCents ?? 0) < 0) {
            return res.status(400).json({
              ok: false,
              error: "price inválido: envie price_cents (centavos) ou price (reais, ex: 19,90)",
            });
          }
        }

        const finalPriceCents = priceCents;
        if (!plan && finalPriceCents === null) {
          return res.status(400).json({
            ok: false,
            error: "price inválido: envie price_cents (centavos) ou price (reais, ex: 19,90)",
          });
        }

        const insertQuery = `
          INSERT INTO bot_downsells
            (bot_slug, price_cents, copy, media_url, media_type, trigger, delay_minutes, sort_order, active, plan_id, created_at, updated_at)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
          RETURNING *;
        `;
        const values = [botSlug, finalPriceCents, copy, mediaUrl, mediaType, trigger, delayMinutes, sortOrder, active, planId];
        const { rows } = await pool.query(insertQuery, values);
        return res.status(201).json({ ok: true, downsell: rows[0] });
      } catch (err) {
        logger.error({ err }, '[ADMIN][DOWNSELLS][POST] error');
        return res.status(500).json({ ok: false, error: 'internal_error', details: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  app.get(
    '/admin/api/downsells',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const rawBotSlug = req.query?.bot_slug as string | string[] | undefined;
        const botSlug = sanitizeStr(Array.isArray(rawBotSlug) ? rawBotSlug[0] : rawBotSlug, 200).toLowerCase();
        if (!botSlug) {
          return res.status(400).json({ ok: false, error: 'bot_slug obrigatório' });
        }

        const { rows } = await pool.query(
          `
            SELECT d.*, p.name AS plan_name, p.price_cents AS plan_price_cents
              FROM bot_downsells d
              LEFT JOIN bot_plans p ON p.id = d.plan_id
             WHERE d.bot_slug = $1
             ORDER BY d.delay_minutes ASC, d.created_at ASC;
          `,
          [botSlug]
        );

        return res.json(rows);
      } catch (err) {
        logger.error({ err }, '[ADMIN][DOWNSELLS][GET] error');
        return res.status(500).json({ ok: false, error: 'internal_error', details: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  app.delete(
    '/admin/api/downsells/:id',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const idNum = Number(req.params.id);
        if (!Number.isInteger(idNum) || idNum <= 0) {
          return res.status(400).json({ ok: false, error: 'invalid_id' });
        }

        const { rowCount } = await pool.query('DELETE FROM bot_downsells WHERE id = $1', [idNum]);
        if (rowCount === 0) {
          return res.status(404).json({ ok: false, error: 'not_found' });
        }

        return res.status(200).json({ ok: true, deleted_id: idNum });
      } catch (err) {
        logger.error({ err }, '[ADMIN][DOWNSELLS][DELETE] error');
        return res.status(500).json({
          ok: false,
          error: 'internal_error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  app.put(
    '/admin/api/downsells/:id',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const downsellId = Number(req.params.id);
        if (!Number.isInteger(downsellId) || downsellId <= 0) {
          return res.status(400).json({ error: 'invalid_downsell_id' });
        }

        const existing = await pool.query(
          'SELECT id, bot_slug, plan_id, price_cents FROM bot_downsells WHERE id = $1 LIMIT 1',
          [downsellId]
        );
        if (existing.rowCount === 0) {
          return res.status(404).json({ error: 'downsells_not_found' });
        }

        const payload = (req.body ?? {}) as Partial<DownsellPayload> & Record<string, unknown>;

        const sets: string[] = [];
        const values: unknown[] = [];
        const pushSet = (column: string, value: unknown) => {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        };

        const currentRow = existing.rows[0];
        const currentPlanId = currentRow.plan_id === null || currentRow.plan_id === undefined ? null : Number(currentRow.plan_id);
        const currentPriceCents =
          currentRow.price_cents === null || currentRow.price_cents === undefined
            ? null
            : Number(currentRow.price_cents);
        let nextBotSlug = String(currentRow.bot_slug ?? '').toLowerCase();

        if ('bot_slug' in payload) {
          const botSlug = sanitizeStr(payload.bot_slug, 200).toLowerCase();
          if (!botSlug) {
            return res.status(400).json({ error: 'bot_slug obrigatório' });
          }
          nextBotSlug = botSlug;
          pushSet('bot_slug', botSlug);
        }

        if ('copy' in payload) {
          const copy = sanitizeStr(payload.copy, 8000);
          if (!copy) {
            return res.status(400).json({ error: 'copy obrigatória' });
          }
          pushSet('copy', copy);
        }

        let planIdOverride: number | null | undefined;
        if ('plan_id' in payload || 'planId' in payload) {
          const rawPlanId = payload.plan_id ?? (payload as { planId?: unknown }).planId;
          const planId = normalizePlanId(rawPlanId);
          planIdOverride = planId;
          if (planId !== null) {
            const plan = await findActivePlanForBot(planId, nextBotSlug);
            if (!plan) {
              return res.status(400).json({ error: 'plan_id inválido para este bot' });
            }
          }
          pushSet('plan_id', planId);
        }

        if ('media_url' in payload) {
          const mediaUrl = payload.media_url === null ? null : sanitizeStr(payload.media_url, 2000);
          pushSet('media_url', mediaUrl);
        }

        if ('media_type' in payload) {
          const mediaType = payload.media_type === null ? null : normalizeMediaType(payload.media_type);
          pushSet('media_type', mediaType);
        }

        const finalPlanId = planIdOverride !== undefined ? planIdOverride : currentPlanId;

        if (planIdOverride === undefined && nextBotSlug !== String(currentRow.bot_slug ?? '').toLowerCase()) {
          if (finalPlanId !== null) {
            const plan = await findActivePlanForBot(finalPlanId, nextBotSlug);
            if (!plan) {
              return res.status(400).json({ error: 'plan_id inválido para este bot' });
            }
          }
        }

        const hasTriggerUpdate = 'trigger' in payload || 'moment' in payload;
        if (hasTriggerUpdate) {
          const rawTrigger = payload.trigger ?? (payload as { moment?: unknown }).moment;
          pushSet('trigger', normalizeTrigger(rawTrigger));
        }

        if ('delay_minutes' in payload) {
          pushSet('delay_minutes', clampDelayMinutes(payload.delay_minutes));
        }

        if ('sort_order' in payload) {
          const sortOrder = normalizeSortOrder(payload.sort_order);
          pushSet('sort_order', sortOrder);
        }

        if ('active' in payload && typeof payload.active === 'boolean') {
          pushSet('active', payload.active);
        }

        const hasPriceUpdate = ['price_cents', 'price', 'price_brl', 'price_reais'].some((key) => key in payload);

        if (finalPlanId === null && !hasPriceUpdate) {
          const hasExistingPrice = typeof currentPriceCents === 'number' && Number.isFinite(currentPriceCents) && currentPriceCents > 0;
          if (!hasExistingPrice) {
            return res.status(400).json({
              error: 'invalid_price',
              message: 'downsells sem plano precisam de preço',
            });
          }
        }

        if (hasPriceUpdate) {
          const priceCandidate = computePriceCents(payload);
          const priceProvided = wasPriceProvided(payload);
          const hasFinitePrice = Number.isFinite(priceCandidate);
          const nextPriceCents = hasFinitePrice ? Number(priceCandidate) : null;

          if (finalPlanId === null) {
            if (!hasFinitePrice || nextPriceCents === null || nextPriceCents < 0) {
              return res.status(400).json({
                error: 'invalid_price',
                message: "price inválido: envie price_cents (centavos) ou price (reais, ex: 19,90)",
              });
            }
          } else if (priceProvided) {
            if (!hasFinitePrice || (nextPriceCents ?? 0) < 0) {
              return res.status(400).json({
                error: 'invalid_price',
                message: "price inválido: envie price_cents (centavos) ou price (reais, ex: 19,90)",
              });
            }
          }

          if (finalPlanId === null && nextPriceCents === null) {
            return res.status(400).json({
              error: 'invalid_price',
              message: 'downsells sem plano precisam de preço',
            });
          }

          pushSet('price_cents', nextPriceCents);
        }

        if (sets.length === 0) {
          return res.status(400).json({ error: 'no_fields_to_update' });
        }

        sets.push('updated_at = now()');

        values.push(downsellId);
        const sql = `
          UPDATE bot_downsells
             SET ${sets.join(', ')}
           WHERE id = $${values.length}
           RETURNING id, bot_slug, price_cents, copy, media_url, media_type, trigger, delay_minutes, sort_order, active, plan_id, created_at, updated_at;
        `;

        const result = await pool.query(sql, values);
        const updated = result.rows[0];
        logger.info({ id: updated.id, bot_slug: updated.bot_slug }, '[ADMIN][DOWNSELLS][PUT] updated');
        return res.status(200).json(updated);
      } catch (err) {
        logger.error({ err }, '[ADMIN][DOWNSELLS][PUT] error');
        return res.status(500).json({
          ok: false,
          error: 'internal_error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}

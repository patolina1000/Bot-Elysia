import type { Express, Request, Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

type DownsellTrigger = 'after_start' | 'after_pix';
type DownsellMediaType = 'photo' | 'video' | 'audio';

type DownsellPayload = {
  bot_slug: string;
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
        const payload = req.body as Partial<DownsellPayload>;

        const botSlug = sanitizeStr(payload.bot_slug, 200).toLowerCase();
        const copy = sanitizeStr(payload.copy, 8000);
        const mediaUrl = payload.media_url ? sanitizeStr(payload.media_url, 2000) : null;
        const rawMediaType = payload.media_type ? sanitizeStr(payload.media_type, 16) : null;
        const mediaType: DownsellMediaType | null = rawMediaType &&
          ['photo', 'video', 'audio'].includes(rawMediaType)
            ? (rawMediaType as DownsellMediaType)
            : null;
        const rawTrigger = (payload.trigger ?? (payload as { moment?: unknown })?.moment) as string | undefined;
        const trigger: DownsellTrigger = rawTrigger === 'after_pix' ? 'after_pix' : 'after_start';
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
        const sortOrder = Number.isFinite(payload?.sort_order as number)
          ? Number(payload!.sort_order)
          : null;
        let delayMinutes = Number.isFinite(payload?.delay_minutes as number)
          ? Number(payload!.delay_minutes)
          : 0;
        if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
          delayMinutes = 0;
        }
        if (delayMinutes > 10080) {
          delayMinutes = 10080;
        }
        const active = typeof payload?.active === 'boolean' ? payload!.active : true;

        if (!botSlug) {
          return res.status(400).json({ ok: false, error: 'bot_slug obrigatório' });
        }
        if (!copy) {
          return res.status(400).json({ ok: false, error: 'copy obrigatória' });
        }
        if (!Number.isFinite(priceCents) || priceCents < 0) {
          return res.status(400).json({
            ok: false,
            error: "price inválido: envie price_cents (centavos) ou price (reais, ex: 19,90)",
          });
        }

        const insertQuery = `
          INSERT INTO bot_downsells
            (bot_slug, price_cents, copy, media_url, media_type, trigger, delay_minutes, sort_order, active, created_at, updated_at)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
          RETURNING *;
        `;
        const values = [botSlug, priceCents, copy, mediaUrl, mediaType, trigger, delayMinutes, sortOrder, active];
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
            SELECT *
            FROM bot_downsells
            WHERE bot_slug = $1
            ORDER BY delay_minutes ASC, created_at ASC;
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
}

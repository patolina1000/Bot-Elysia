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
        sort_order   integer DEFAULT 0,
        active       boolean DEFAULT true,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_bot_downsells_bot_slug_sort'
        ) THEN
          CREATE UNIQUE INDEX ux_bot_downsells_bot_slug_sort ON bot_downsells(bot_slug, sort_order);
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
        const trigger: DownsellTrigger = payload.trigger === 'after_pix' ? 'after_pix' : 'after_start';
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
          : 0;
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
            (bot_slug, price_cents, copy, media_url, media_type, trigger, sort_order, active, created_at, updated_at)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
          RETURNING *;
        `;
        const values = [botSlug, priceCents, copy, mediaUrl, mediaType, trigger, sortOrder, active];
        const { rows } = await pool.query(insertQuery, values);
        return res.status(201).json({ ok: true, downsell: rows[0] });
      } catch (err) {
        logger.error({ err }, '[ADMIN][DOWNSELLS][POST] error');
        return res.status(500).json({ ok: false, error: 'internal_error', details: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}

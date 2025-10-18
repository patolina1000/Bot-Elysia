import type { Express, Request, Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { logger } from '../logger.js';
import {
  shotsService,
  ShotsServiceError,
} from '../services/ShotsService.js';

function sanitizeStr(value: unknown, max = 5000): string {
  const str = String(value ?? '').trim();
  return str.length > max ? str.slice(0, max) : str;
}

function normalizeLegacyTarget(value: unknown): 'all_started' | 'pix_generated' {
  const normalized = sanitizeStr(value, 32).toLowerCase();
  if (normalized === 'pix_created' || normalized === 'pix_generated') {
    return 'pix_generated';
  }
  return 'all_started';
}

function normalizeMediaType(value: unknown): 'none' | 'photo' | 'video' | 'audio' | 'document' {
  const normalized = sanitizeStr(value, 16).toLowerCase();
  if (normalized === 'photo' || normalized === 'video' || normalized === 'audio' || normalized === 'document') {
    return normalized;
  }
  return 'none';
}

function parseScheduledAt(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseShotId(req: Request): number | null {
  const shotId = Number(req.params.id);
  if (!Number.isInteger(shotId) || shotId <= 0) {
    return null;
  }
  return shotId;
}

function handleServiceError(res: Response, err: unknown, scope: string): Response {
  if (err instanceof ShotsServiceError) {
    logger.warn({ err, scope }, '[ADMIN][SHOTS][SERVICE_ERROR]');
    return res.status(err.statusCode).json({
      ok: false,
      error: err.code,
      message: err.message,
      details: err.details ?? null,
    });
  }
  logger.error({ err, scope }, '[ADMIN][SHOTS][UNEXPECTED_ERROR]');
  return res.status(500).json({
    ok: false,
    error: 'internal_error',
    details: err instanceof Error ? err.message : String(err),
  });
}

export function registerAdminShotsRoutes(app: Express): void {
  app.post(
    '/admin/api/shots',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const body = req.body ?? {};

        const botSlug = sanitizeStr(body.bot_slug, 200).toLowerCase();
        if (!botSlug) {
          return res.status(400).json({ ok: false, error: 'bot_slug obrigatório' });
        }

        const copy = sanitizeStr(body.copy, 8000);
        if (!copy) {
          return res.status(400).json({ ok: false, error: 'copy obrigatória' });
        }

        const shot = await shotsService.createShot({
          bot_slug: botSlug,
          title: body.title ? sanitizeStr(body.title, 200) : null,
          copy,
          target: normalizeLegacyTarget(body.target),
          media_type: normalizeMediaType(body.media_type),
          media_url: body.media_url ? sanitizeStr(body.media_url, 2000) : null,
          scheduled_at: parseScheduledAt(body.scheduled_at),
        });

        logger.info({ shot_id: shot.id, bot_slug: shot.bot_slug }, '[ADMIN][SHOTS][POST] created');

        return res.status(201).json({ ok: true, shot });
      } catch (err) {
        return handleServiceError(res, err, 'create');
      }
    }
  );

  app.get(
    '/admin/api/shots',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const rawBotSlug = req.query?.bot_slug as string | string[] | undefined;
        const botSlug = sanitizeStr(Array.isArray(rawBotSlug) ? rawBotSlug[0] : rawBotSlug, 200).toLowerCase();

        if (!botSlug) {
          return res.status(400).json({ ok: false, error: 'bot_slug obrigatório' });
        }

        const limit = Number.parseInt(String(req.query?.limit ?? '50'), 10);
        const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50;

        const result = await shotsService.listShots({
          botSlug,
          search: null,
          limit: normalizedLimit,
          offset: 0,
        });

        return res.status(200).json({ ok: true, total: result.total, items: result.items });
      } catch (err) {
        return handleServiceError(res, err, 'list');
      }
    }
  );

  app.patch(
    '/admin/api/shots/:id',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const shotId = parseShotId(req);
        if (!shotId) {
          return res.status(400).json({ ok: false, error: 'invalid_id' });
        }

        const body = req.body ?? {};
        const updates: Parameters<typeof shotsService.updateShot>[1] = {};

        if (body.copy !== undefined) {
          const copy = sanitizeStr(body.copy, 8000);
          if (!copy) {
            return res.status(400).json({ ok: false, error: 'copy não pode ser vazia' });
          }
          updates.copy = copy;
        }

        if (body.media_type !== undefined) {
          updates.media_type = normalizeMediaType(body.media_type);
        }

        if (body.media_url !== undefined) {
          updates.media_url = body.media_url ? sanitizeStr(body.media_url, 2000) : null;
        }

        if (body.target !== undefined) {
          updates.target = normalizeLegacyTarget(body.target);
        }

        if (body.title !== undefined) {
          updates.title = body.title ? sanitizeStr(body.title, 200) : null;
        }

        if (body.bot_slug !== undefined) {
          updates.bot_slug = sanitizeStr(body.bot_slug, 200).toLowerCase();
        }

        if (body.scheduled_at !== undefined) {
          updates.scheduled_at = parseScheduledAt(body.scheduled_at);
        }

        if (Object.keys(updates).length === 0) {
          return res.status(400).json({ ok: false, error: 'no_fields_to_update' });
        }

        const shot = await shotsService.updateShot(shotId, updates);

        logger.info({ shot_id: shotId }, '[ADMIN][SHOTS][PATCH] updated');

        return res.status(200).json({ ok: true, shot });
      } catch (err) {
        return handleServiceError(res, err, 'update');
      }
    }
  );

  app.delete(
    '/admin/api/shots/:id',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const shotId = parseShotId(req);
        if (!shotId) {
          return res.status(400).json({ ok: false, error: 'invalid_id' });
        }

        await shotsService.deleteShot(shotId);

        logger.info({ shot_id: shotId }, '[ADMIN][SHOTS][DELETE] deleted');

        return res.status(200).json({ ok: true, deleted_id: shotId });
      } catch (err) {
        return handleServiceError(res, err, 'delete');
      }
    }
  );

  app.get(
    '/admin/api/shots/:id/stats',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const shotId = parseShotId(req);
        if (!shotId) {
          return res.status(400).json({ ok: false, error: 'invalid_id' });
        }

        const stats = await shotsService.getShotStats(shotId);

        return res.status(200).json({ ok: true, shot_id: shotId, stats });
      } catch (err) {
        return handleServiceError(res, err, 'stats');
      }
    }
  );
}

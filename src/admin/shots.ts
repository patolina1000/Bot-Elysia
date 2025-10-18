import type { Express, Request, Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { logger } from '../logger.js';
import {
  createShot,
  listShots,
  getShotById,
  updateShot,
  deleteShot,
  type ShotTarget,
  type MediaType,
  type CreateShotParams,
} from '../db/shotsQueue.js';
import { getShotStats } from '../db/shotsSent.js';
import { pool } from '../db/pool.js';

function sanitizeStr(value: unknown, max = 5000): string {
  const str = String(value ?? '').trim();
  return str.length > max ? str.slice(0, max) : str;
}

function normalizeShotTarget(value: unknown): ShotTarget | null {
  const str = sanitizeStr(value, 32).toLowerCase();
  if (str === 'started' || str === 'pix_created') {
    return str as ShotTarget;
  }
  return null;
}

function normalizeMediaType(value: unknown): MediaType {
  const str = sanitizeStr(value, 16).toLowerCase();
  if (str === 'photo' || str === 'video' || str === 'audio' || str === 'document') {
    return str as MediaType;
  }
  return 'none';
}

function parseScheduledAt(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = new Date(String(value));
  return isNaN(date.getTime()) ? undefined : date;
}

async function validateBotSlug(botSlug: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM bots WHERE slug = $1 LIMIT 1',
    [botSlug]
  );
  return rows.length > 0;
}

export function registerAdminShotsRoutes(app: Express): void {
  // POST /admin/shots - Create new shot
  app.post(
    '/admin/api/shots',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const body = req.body;

        const botSlug = sanitizeStr(body.bot_slug, 200).toLowerCase();
        if (!botSlug) {
          return res.status(400).json({ ok: false, error: 'bot_slug obrigatório' });
        }

        // Validate bot exists
        const botExists = await validateBotSlug(botSlug);
        if (!botExists) {
          return res.status(400).json({ ok: false, error: 'bot_slug inválido' });
        }

        const target = normalizeShotTarget(body.target);
        if (!target) {
          return res.status(400).json({
            ok: false,
            error: 'target deve ser "started" ou "pix_created"',
          });
        }

        const copy = sanitizeStr(body.copy, 8000);
        if (!copy) {
          return res.status(400).json({ ok: false, error: 'copy obrigatória' });
        }

        const mediaUrl = body.media_url ? sanitizeStr(body.media_url, 2000) : null;
        const mediaType = normalizeMediaType(body.media_type);
        const scheduledAt = parseScheduledAt(body.scheduled_at);

        const params: CreateShotParams = {
          bot_slug: botSlug,
          target,
          copy,
          media_url: mediaUrl,
          media_type: mediaType,
          scheduled_at: scheduledAt,
        };

        const shot = await createShot(params);

        logger.info(
          { shot_id: shot.id, bot_slug: botSlug, target, scheduled_at: shot.scheduled_at },
          '[ADMIN][SHOTS][POST] created'
        );

        return res.status(201).json({ ok: true, shot });
      } catch (err) {
        logger.error({ err }, '[ADMIN][SHOTS][POST] error');
        return res.status(500).json({
          ok: false,
          error: 'internal_error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  // GET /admin/shots?bot_slug=... - List shots for a bot
  app.get(
    '/admin/api/shots',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const rawBotSlug = req.query?.bot_slug as string | string[] | undefined;
        const botSlug = sanitizeStr(
          Array.isArray(rawBotSlug) ? rawBotSlug[0] : rawBotSlug,
          200
        ).toLowerCase();

        if (!botSlug) {
          return res.status(400).json({ ok: false, error: 'bot_slug obrigatório' });
        }

        const limit = parseInt(String(req.query?.limit ?? '50'));
        const shots = await listShots(botSlug, limit);

        // Enrich with basic stats
        const enrichedShots = await Promise.all(
          shots.map(async (shot) => {
            if (shot.status === 'sent' || shot.status === 'success') {
              const stats = await getShotStats(shot.id);
              return { ...shot, stats };
            }
            return shot;
          })
        );

        return res.status(200).json({ items: enrichedShots });
      } catch (err) {
        logger.error({ err }, '[ADMIN][SHOTS][GET] error');
        return res.status(500).json({
          ok: false,
          error: 'internal_error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  // PATCH /admin/shots/:id - Update pending shot
  app.patch(
    '/admin/api/shots/:id',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const shotId = Number(req.params.id);
        if (!Number.isInteger(shotId) || shotId <= 0) {
          return res.status(400).json({ ok: false, error: 'invalid_id' });
        }

        const shot = await getShotById(shotId);
        if (!shot) {
          return res.status(404).json({ ok: false, error: 'not_found' });
        }

        if (shot.status !== 'pending') {
          return res.status(400).json({
            ok: false,
            error: 'only_pending_can_be_updated',
            message: 'Apenas disparos com status "pending" podem ser editados',
          });
        }

        const body = req.body;
        const updates: any = {};

        if ('copy' in body) {
          const copy = sanitizeStr(body.copy, 8000);
          if (!copy) {
            return res.status(400).json({ ok: false, error: 'copy não pode ser vazia' });
          }
          updates.copy = copy;
        }

        if ('media_url' in body) {
          updates.media_url = body.media_url ? sanitizeStr(body.media_url, 2000) : null;
        }

        if ('media_type' in body) {
          updates.media_type = normalizeMediaType(body.media_type);
        }

        if ('scheduled_at' in body) {
          const scheduledAt = parseScheduledAt(body.scheduled_at);
          if (!scheduledAt) {
            return res.status(400).json({ ok: false, error: 'invalid_scheduled_at' });
          }
          updates.scheduled_at = scheduledAt;
        }

        if (Object.keys(updates).length === 0) {
          return res.status(400).json({ ok: false, error: 'no_fields_to_update' });
        }

        const updated = await updateShot(shotId, updates);

        logger.info({ shot_id: shotId, updates }, '[ADMIN][SHOTS][PATCH] updated');

        return res.status(200).json({ ok: true, shot: updated });
      } catch (err) {
        logger.error({ err }, '[ADMIN][SHOTS][PATCH] error');
        return res.status(500).json({
          ok: false,
          error: 'internal_error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  // DELETE /admin/shots/:id - Cancel pending shot
  app.delete(
    '/admin/api/shots/:id',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const shotId = Number(req.params.id);
        if (!Number.isInteger(shotId) || shotId <= 0) {
          return res.status(400).json({ ok: false, error: 'invalid_id' });
        }

        const deleted = await deleteShot(shotId);
        if (!deleted) {
          return res.status(404).json({
            ok: false,
            error: 'not_found_or_not_pending',
            message: 'Disparo não encontrado ou não está pendente',
          });
        }

        logger.info({ shot_id: shotId }, '[ADMIN][SHOTS][DELETE] deleted');

        return res.status(200).json({ ok: true, deleted_id: shotId });
      } catch (err) {
        logger.error({ err }, '[ADMIN][SHOTS][DELETE] error');
        return res.status(500).json({
          ok: false,
          error: 'internal_error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  // GET /admin/shots/:id/stats - Get detailed stats for a shot
  app.get(
    '/admin/api/shots/:id/stats',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const shotId = Number(req.params.id);
        if (!Number.isInteger(shotId) || shotId <= 0) {
          return res.status(400).json({ ok: false, error: 'invalid_id' });
        }

        const shot = await getShotById(shotId);
        if (!shot) {
          return res.status(404).json({ ok: false, error: 'not_found' });
        }

        const stats = await getShotStats(shotId);

        return res.status(200).json({
          ok: true,
          shot_id: shotId,
          status: shot.status,
          stats,
        });
      } catch (err) {
        logger.error({ err }, '[ADMIN][SHOTS][STATS] error');
        return res.status(500).json({
          ok: false,
          error: 'internal_error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}

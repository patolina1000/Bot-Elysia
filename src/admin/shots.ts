import type { Express, Request, Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { logger } from '../logger.js';
import {
  createShot,
  listShots,
  getShotById,
  updateShotStatus,
  deleteShot,
  type CreateShotParams,
  type ShotAudience,
  type ShotSendMode,
} from '../db/shots.js';
import { scheduleShotDelivery } from '../services/shots/scheduler.js';

function sanitizeStr(value: unknown, max = 5000): string {
  const str = String(value ?? '').trim();
  return str.length > max ? str.slice(0, max) : str;
}

function toCentsBRL(input: unknown): number | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const str = String(input).trim();
  if (!str) return null;
  const normalized = str.replace(/\./g, '').replace(',', '.');
  const value = Number(normalized);
  if (Number.isNaN(value) || value < 0) return null;
  return Math.round(value * 100);
}

type SanitizedExtraPlan = { label: string; price_cents: number };

function sanitizeExtraPlans(
  raw: any
): { ok: boolean; value: SanitizedExtraPlan[]; error?: string } {
  const arr = Array.isArray(raw) ? raw : [];
  const out: Array<{ label: string; price_cents: number }> = [];

  if (arr.length > 8) {
    return { ok: false, value: [], error: 'extra_plans cannot have more than 8 items' };
  }

  for (const it of arr) {
    const cents = toCentsBRL(it?.price ?? it?.price_cents);
    if (cents == null) continue;

    let label = (it?.label ?? '').toString().trim();
    if (!label) continue;

    out.push({ label, price_cents: cents });
  }

  return { ok: true, value: out };
}

function normalizeAudience(value: unknown): ShotAudience {
  const str = sanitizeStr(value ?? '', 32);
  return str === 'pix' ? 'pix' : 'started';
}

function normalizeSendMode(value: unknown): ShotSendMode {
  const str = sanitizeStr(value ?? '', 32);
  return str === 'scheduled' ? 'scheduled' : 'now';
}

function parseScheduledAt(
  dateStr: unknown,
  timeStr: unknown,
  timezone: string
): Date | null {
  if (!dateStr || !timeStr) return null;

  const date = String(dateStr).trim();
  const time = String(timeStr).trim();
  
  if (!date || !time) return null;

  // Combine date and time in the format: YYYY-MM-DD HH:mm
  const combined = `${date} ${time}`;
  
  // Parse in the specified timezone and convert to UTC
  try {
    // For simplicity, we'll use Date constructor which assumes local time
    // In production, you'd want to use a library like date-fns-tz or moment-timezone
    const localDate = new Date(combined);
    if (isNaN(localDate.getTime())) {
      return null;
    }
    return localDate;
  } catch {
    return null;
  }
}

export function registerAdminShotsRoutes(app: Express): void {
  // Create shot
  app.post(
    '/admin/api/shots',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const payload = req.body as any;

        const botSlug = sanitizeStr(payload.bot_slug, 200).toLowerCase();
        const audience = normalizeAudience(payload.audience);
        const sendMode = normalizeSendMode(payload.send_mode);
        const timezone = sanitizeStr(payload.timezone || 'America/Sao_Paulo', 100);
        const buttonText = sanitizeStr(payload.button_text, 200);
        const introText = payload.intro_text ? sanitizeStr(payload.intro_text, 500) : null;
        const copy = payload.copy ? sanitizeStr(payload.copy, 8000) : null;
        const mediaUrl = payload.media_url ? sanitizeStr(payload.media_url, 2000) : null;
        const mediaType = payload.media_type ? sanitizeStr(payload.media_type, 50) : null;

        if (!botSlug) {
          return res.status(400).json({ ok: false, error: 'bot_slug obrigatório' });
        }

        if (!buttonText) {
          return res.status(400).json({ ok: false, error: 'button_text obrigatório' });
        }

        // Parse price
        const priceCents = toCentsBRL(payload.price_cents ?? payload.price);

        // Parse extra plans
        const rawExtra = payload.extra_plans ?? payload.extraPlans ?? [];
        const parsedExtraPlans = sanitizeExtraPlans(rawExtra);
        if (!parsedExtraPlans.ok) {
          return res.status(400).json({ ok: false, error: parsedExtraPlans.error });
        }
        const extraPlans = parsedExtraPlans.value;

        // Validate: must have price_cents OR extra_plans
        const hasValidPrice = priceCents !== null && priceCents > 0;
        const hasValidExtraPlans = extraPlans.length > 0;

        if (!hasValidPrice && !hasValidExtraPlans) {
          return res.status(400).json({
            ok: false,
            error: 'Você deve fornecer price_cents OU extra_plans',
          });
        }

        // Parse scheduled_at if send_mode is 'scheduled'
        let scheduledAt: Date | null = null;
        if (sendMode === 'scheduled') {
          scheduledAt = parseScheduledAt(payload.date, payload.time, timezone);
          if (!scheduledAt) {
            return res.status(400).json({
              ok: false,
              error: 'send_mode=scheduled requer date e time válidos',
            });
          }
        }

        const params: CreateShotParams = {
          bot_slug: botSlug,
          audience,
          send_mode: sendMode,
          scheduled_at: scheduledAt,
          timezone,
          button_text: buttonText,
          price_cents: priceCents,
          extra_plans: extraPlans,
          intro_text: introText,
          copy,
          media_url: mediaUrl,
          media_type: mediaType,
        };

        const shot = await createShot(params);

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

  // List shots
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

        const shots = await listShots(botSlug);

        return res.status(200).json({ items: shots });
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

  // Queue shot (send now)
  app.post(
    '/admin/api/shots/:id/queue',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const shotId = Number(req.params.id);
        if (!Number.isInteger(shotId) || shotId <= 0) {
          return res.status(400).json({ ok: false, error: 'invalid_id' });
        }

        const shot = await getShotById(shotId);
        if (!shot) {
          return res.status(404).json({ ok: false, error: 'shot_not_found' });
        }

        // Update to send_mode = 'now' if needed
        if (shot.send_mode !== 'now') {
          await updateShotStatus(shotId, 'draft');
        }

        // Schedule delivery
        const result = await scheduleShotDelivery({ shot_id: shotId });

        return res.status(200).json({
          ok: true,
          shot_id: shotId,
          queued: result.queued,
          skipped: result.skipped,
          errors: result.errors,
        });
      } catch (err) {
        logger.error({ err }, '[ADMIN][SHOTS][QUEUE] error');
        return res.status(500).json({
          ok: false,
          error: 'internal_error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  // Schedule shot (send at specific time)
  app.post(
    '/admin/api/shots/:id/schedule',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const shotId = Number(req.params.id);
        if (!Number.isInteger(shotId) || shotId <= 0) {
          return res.status(400).json({ ok: false, error: 'invalid_id' });
        }

        const payload = req.body as any;
        const timezone = sanitizeStr(payload.timezone || 'America/Sao_Paulo', 100);
        const scheduledAt = parseScheduledAt(payload.date, payload.time, timezone);

        if (!scheduledAt) {
          return res.status(400).json({
            ok: false,
            error: 'date e time são obrigatórios',
          });
        }

        const shot = await getShotById(shotId);
        if (!shot) {
          return res.status(404).json({ ok: false, error: 'shot_not_found' });
        }

        // Schedule delivery
        const result = await scheduleShotDelivery({ shot_id: shotId });

        return res.status(200).json({
          ok: true,
          shot_id: shotId,
          scheduled_at: scheduledAt.toISOString(),
          queued: result.queued,
          skipped: result.skipped,
          errors: result.errors,
        });
      } catch (err) {
        logger.error({ err }, '[ADMIN][SHOTS][SCHEDULE] error');
        return res.status(500).json({
          ok: false,
          error: 'internal_error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  // Delete shot
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
          return res.status(404).json({ ok: false, error: 'shot_not_found' });
        }

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
}

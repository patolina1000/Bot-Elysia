// DEPRECATED: estas rotas existem apenas para compatibilidade com o painel antigo (/admin/shots.html).
// Toda a lógica real de disparos está em src/api/admin/shots.controller.ts
import { Router, type Request, type Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import {
  createShotAction,
  deleteShotAction,
  getStatsAction,
  handleShotsControllerError,
  listShotsAction,
  triggerShotAction,
  updateShotAction,
} from '../api/admin/shots.controller.js';

const MAX_COPY_LENGTH = 8000;
const MAX_TITLE_LENGTH = 200;
const MAX_MEDIA_URL_LENGTH = 2000;

function sanitizeStr(value: unknown, max = 5000): string {
  const str = String(value ?? '').trim();
  return str.length > max ? str.slice(0, max) : str;
}

function normalizeLegacyTarget(value: unknown): 'all_started' | 'pix_generated' {
  const normalized = sanitizeStr(value, 32).toLowerCase();
  if (normalized === 'pix_created' || normalized === 'pix_generated') {
    return 'pix_generated';
  }
  if (normalized === 'started' || normalized === 'all_started') {
    return 'all_started';
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

function withLegacyErrorHandling(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          return originalJson({ ok: false, ...body });
        }
        return originalJson(body);
      };
      handleShotsControllerError(res, err);
      res.json = originalJson;
    }
  };
}

const router = Router();

router.use(authAdminMiddleware);

router.get(
  '/',
  withLegacyErrorHandling(async (req, res) => {
    const rawBotSlug = req.query?.bot_slug as string | string[] | undefined;
    const botSlug = sanitizeStr(Array.isArray(rawBotSlug) ? rawBotSlug[0] : rawBotSlug, 200).toLowerCase();
    const limitValue = Number.parseInt(String(req.query?.limit ?? '50'), 10);
    const normalizedLimit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 100) : undefined;
    const offsetValue = Number.parseInt(String(req.query?.offset ?? '0'), 10);
    const normalizedOffset = Number.isFinite(offsetValue) && offsetValue >= 0 ? offsetValue : undefined;
    const search = req.query?.q ?? req.query?.search;
    const payload = await listShotsAction({
      bot_slug: botSlug,
      limit: normalizedLimit,
      offset: normalizedOffset,
      q: search ? String(Array.isArray(search) ? search[0] : search) : undefined,
    });
    res.json({ ok: true, total: payload.total, items: payload.items });
  })
);

router.post(
  '/',
  withLegacyErrorHandling(async (req, res) => {
    const body = req.body ?? {};
    const shot = await createShotAction({
      bot_slug: sanitizeStr(body.bot_slug, 200).toLowerCase(),
      title: body.title ? sanitizeStr(body.title, MAX_TITLE_LENGTH) : null,
      copy: sanitizeStr(body.copy, MAX_COPY_LENGTH),
      target: normalizeLegacyTarget(body.target),
      media_type: normalizeMediaType(body.media_type),
      media_url: body.media_url ? sanitizeStr(body.media_url, MAX_MEDIA_URL_LENGTH) : null,
      scheduled_at: parseScheduledAt(body.scheduled_at),
    });
    res.status(201).json({ ok: true, shot });
  })
);

router.patch(
  '/:id',
  withLegacyErrorHandling(async (req, res) => {
    const body = req.body ?? {};
    const payload: Record<string, unknown> = {};

    if (body.copy !== undefined) {
      payload.copy = sanitizeStr(body.copy, MAX_COPY_LENGTH);
    }
    if (body.media_type !== undefined) {
      payload.media_type = normalizeMediaType(body.media_type);
    }
    if (body.media_url !== undefined) {
      payload.media_url = body.media_url ? sanitizeStr(body.media_url, MAX_MEDIA_URL_LENGTH) : null;
    }
    if (body.target !== undefined) {
      payload.target = normalizeLegacyTarget(body.target);
    }
    if (body.title !== undefined) {
      payload.title = body.title ? sanitizeStr(body.title, MAX_TITLE_LENGTH) : null;
    }
    if (body.bot_slug !== undefined) {
      payload.bot_slug = sanitizeStr(body.bot_slug, 200).toLowerCase();
    }
    if (body.scheduled_at !== undefined) {
      payload.scheduled_at = parseScheduledAt(body.scheduled_at);
    }

    const shot = await updateShotAction(req.params.id, payload);
    res.json({ ok: true, shot });
  })
);

router.delete(
  '/:id',
  withLegacyErrorHandling(async (req, res) => {
    await deleteShotAction(req.params.id);
    res.json({ ok: true, deleted_id: Number(req.params.id) });
  })
);

router.get(
  '/:id/stats',
  withLegacyErrorHandling(async (req, res) => {
    const stats = await getStatsAction(req.params.id);
    res.json({ ok: true, shot_id: Number(req.params.id), stats });
  })
);

router.post(
  '/:id/trigger',
  withLegacyErrorHandling(async (req, res) => {
    const payload = await triggerShotAction(req.params.id, req.body ?? {});
    res.json({ ok: true, ...payload });
  })
);

export const legacyAdminShotsRouter = router;
export default router;

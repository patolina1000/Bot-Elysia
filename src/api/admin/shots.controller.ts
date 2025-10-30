import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  shotsService,
  ShotsService,
  ShotsServiceError,
  ValidationError,
} from '../../services/ShotsService.js';
import { logger } from '../../logger.js';

const listQuerySchema = z.object({
  bot_slug: z.string().min(1, 'bot_slug obrigatório'),
  q: z.string().optional(),
  limit: z
    .preprocess((value) => (value === undefined ? 30 : value), z.coerce.number().int().min(1).max(100))
    .default(30),
  offset: z
    .preprocess((value) => (value === undefined ? 0 : value), z.coerce.number().int().min(0))
    .default(0),
});

const shotBodySchema = z.object({
  bot_slug: z.string().min(1),
  title: z.string().optional().nullable(),
  copy: z.string().min(1),
  target: z.enum(['all_started', 'pix_generated']).default('all_started'),
  media_type: z.enum(['none', 'photo', 'video', 'audio', 'document']).default('none'),
  media_url: z.string().optional().nullable(),
  scheduled_at: z.union([z.string(), z.date()]).optional().nullable(),
});

const shotUpdateSchema = shotBodySchema.partial().extend({
  copy: z.string().min(1).optional(),
});

const planBodySchema = z.object({
  name: z.string().min(1),
  price_cents: z.coerce.number().int().min(0),
  description: z.string().optional().nullable(),
});

const reorderSchema = z.object({
  order: z.array(z.coerce.number().int().positive()),
});

const triggerSchema = z.object({
  mode: z.enum(['now', 'schedule']),
  scheduled_at: z.union([z.string(), z.date()]).optional().nullable(),
});

const previewSchema = z
  .object({
    title: z.string().optional().nullable(),
    copy: z.string().optional().nullable(),
    media_type: z.enum(['none', 'photo', 'video', 'audio', 'document']).optional(),
    media_url: z.string().optional().nullable(),
    plans: z
      .array(
        z.object({
          name: z.string().min(1),
          price_cents: z.coerce.number().int().min(0),
          description: z.string().optional().nullable(),
        })
      )
      .optional(),
  })
  .optional();

function parseId(value: unknown, field = 'id'): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${field} inválido`);
  }
  return parsed;
}

function parseDate(value: unknown | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'VALIDATION_ERROR', details: err.errors });
    return;
  }
  if (err instanceof ShotsServiceError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message, details: err.details ?? null });
    return;
  }
  logger.error({ err }, '[ADMIN][SHOTS][ERROR]');
  res.status(500).json({ error: 'INTERNAL_ERROR' });
}

export type ShotsControllerDependencies = {
  service?: ShotsService;
};

function getService(deps?: ShotsControllerDependencies): ShotsService {
  return deps?.service ?? shotsService;
}

export async function listShotsAction(query: unknown, deps?: ShotsControllerDependencies) {
  const parsed = listQuerySchema.parse(query);
  const service = getService(deps);
  const result = await service.listShots({
    botSlug: parsed.bot_slug,
    search: parsed.q ?? null,
    limit: parsed.limit,
    offset: parsed.offset,
  });
  return {
    total: result.total,
    limit: parsed.limit,
    offset: parsed.offset,
    items: result.items,
  };
}

export async function getShotAction(id: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const service = getService(deps);
  return service.getShotWithPlans(shotId);
}

export async function createShotAction(body: unknown, deps?: ShotsControllerDependencies) {
  const parsed = shotBodySchema.parse(body ?? {});
  const service = getService(deps);
  const scheduledAt = parseDate(parsed.scheduled_at);
  return service.createShot({
    bot_slug: parsed.bot_slug,
    title: parsed.title ?? null,
    copy: parsed.copy,
    target: parsed.target,
    media_type: parsed.media_type,
    media_url: parsed.media_url ?? null,
    scheduled_at: scheduledAt,
  });
}

export async function updateShotAction(id: unknown, body: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const parsed = shotUpdateSchema.parse(body ?? {});
  const payload: Parameters<ShotsService['updateShot']>[1] = {};
  if (parsed.bot_slug !== undefined) payload.bot_slug = parsed.bot_slug;
  if (parsed.title !== undefined) payload.title = parsed.title ?? null;
  if (parsed.copy !== undefined) payload.copy = parsed.copy;
  if (parsed.target !== undefined) payload.target = parsed.target;
  if (parsed.media_type !== undefined) payload.media_type = parsed.media_type;
  if (parsed.media_url !== undefined) payload.media_url = parsed.media_url ?? null;
  if (parsed.scheduled_at !== undefined) payload.scheduled_at = parseDate(parsed.scheduled_at);
  const service = getService(deps);
  return service.updateShot(shotId, payload);
}

export async function deleteShotAction(id: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const service = getService(deps);
  await service.deleteShot(shotId);
}

export async function listPlansAction(id: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const service = getService(deps);
  return service.listPlans(shotId);
}

export async function createPlanAction(id: unknown, body: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const parsed = planBodySchema.parse(body ?? {});
  const service = getService(deps);
  return service.createPlan(shotId, {
    name: parsed.name,
    price_cents: parsed.price_cents,
    description: parsed.description ?? null,
  });
}

export async function updatePlanAction(
  id: unknown,
  planId: unknown,
  body: unknown,
  deps?: ShotsControllerDependencies
) {
  const shotId = parseId(id);
  const normalizedPlanId = parseId(planId, 'planId');
  const parsed = planBodySchema.partial().parse(body ?? {});
  const payload: Parameters<ShotsService['updatePlan']>[2] = {};
  if (parsed.name !== undefined) payload.name = parsed.name;
  if (parsed.price_cents !== undefined) payload.price_cents = parsed.price_cents;
  if (parsed.description !== undefined) payload.description = parsed.description ?? null;
  const service = getService(deps);
  return service.updatePlan(shotId, normalizedPlanId, payload);
}

export async function deletePlanAction(id: unknown, planId: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const normalizedPlanId = parseId(planId, 'planId');
  const service = getService(deps);
  await service.deletePlan(shotId, normalizedPlanId);
}

export async function reorderPlansAction(id: unknown, body: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const parsed = reorderSchema.parse(body ?? {});
  const service = getService(deps);
  return service.reorderPlans(shotId, parsed.order);
}

export async function triggerShotAction(id: unknown, body: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const parsed = triggerSchema.parse(body ?? {});
  const service = getService(deps);
  const scheduledAt = parseDate(parsed.scheduled_at);
  const result = await service.triggerShot(shotId, {
    mode: parsed.mode,
    scheduled_at: scheduledAt,
  });
  return {
    mode: result.mode,
    scheduled_at: result.scheduled_at ? result.scheduled_at.toISOString() : null,
    stats: result.stats ?? null,
  };
}

export async function getStatsAction(id: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const service = getService(deps);
  return service.getShotStats(shotId);
}

export async function previewShotAction(id: unknown, body: unknown, deps?: ShotsControllerDependencies) {
  const shotId = parseId(id);
  const parsed = previewSchema.parse(body ?? {});
  const service = getService(deps);
  return service.previewShot(shotId, parsed ?? undefined);
}

export async function listShots(req: Request, res: Response): Promise<void> {
  try {
    const payload = await listShotsAction(req.query);
    res.json(payload);
  } catch (err) {
    handleError(res, err);
  }
}

export async function getShot(req: Request, res: Response): Promise<void> {
  try {
    const payload = await getShotAction(req.params.id);
    res.json(payload);
  } catch (err) {
    handleError(res, err);
  }
}

export async function createShot(req: Request, res: Response): Promise<void> {
  try {
    const shot = await createShotAction(req.body);
    res.status(201).json({ shot });
  } catch (err) {
    handleError(res, err);
  }
}

export async function updateShot(req: Request, res: Response): Promise<void> {
  try {
    const shot = await updateShotAction(req.params.id, req.body);
    res.json({ shot });
  } catch (err) {
    handleError(res, err);
  }
}

export async function deleteShot(req: Request, res: Response): Promise<void> {
  try {
    await deleteShotAction(req.params.id);
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
}

export async function listPlans(req: Request, res: Response): Promise<void> {
  try {
    const plans = await listPlansAction(req.params.id);
    res.json({ plans });
  } catch (err) {
    handleError(res, err);
  }
}

export async function createPlan(req: Request, res: Response): Promise<void> {
  try {
    const plan = await createPlanAction(req.params.id, req.body);
    res.status(201).json({ plan });
  } catch (err) {
    handleError(res, err);
  }
}

export async function updatePlan(req: Request, res: Response): Promise<void> {
  try {
    const plan = await updatePlanAction(req.params.id, req.params.planId, req.body);
    res.json({ plan });
  } catch (err) {
    handleError(res, err);
  }
}

export async function deletePlan(req: Request, res: Response): Promise<void> {
  try {
    await deletePlanAction(req.params.id, req.params.planId);
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
}

export async function reorderPlans(req: Request, res: Response): Promise<void> {
  try {
    const plans = await reorderPlansAction(req.params.id, req.body);
    res.json({ plans });
  } catch (err) {
    handleError(res, err);
  }
}

export async function triggerShot(req: Request, res: Response): Promise<void> {
  try {
    const payload = await triggerShotAction(req.params.id, req.body);
    res.json(payload);
  } catch (err) {
    handleError(res, err);
  }
}

export async function getStats(req: Request, res: Response): Promise<void> {
  try {
    const stats = await getStatsAction(req.params.id);
    res.json({ stats });
  } catch (err) {
    handleError(res, err);
  }
}

export async function previewShot(req: Request, res: Response): Promise<void> {
  try {
    const preview = await previewShotAction(req.params.id, req.body);
    res.json({ preview });
  } catch (err) {
    handleError(res, err);
  }
}

export function handleShotsControllerError(res: Response, err: unknown): void {
  handleError(res, err);
}

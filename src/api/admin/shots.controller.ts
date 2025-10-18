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

export class ShotsController {
  constructor(private readonly service: ShotsService = shotsService) {}

  private handleError(res: Response, err: unknown): void {
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

  async listShots(req: Request, res: Response): Promise<void> {
    try {
      const query = listQuerySchema.parse(req.query);
      const result = await this.service.listShots({
        botSlug: query.bot_slug,
        search: query.q ?? null,
        limit: query.limit,
        offset: query.offset,
      });
      res.json({
        total: result.total,
        limit: query.limit,
        offset: query.offset,
        items: result.items,
      });
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async getShot(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const result = await this.service.getShotWithPlans(shotId);
      res.json(result);
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async createShot(req: Request, res: Response): Promise<void> {
    try {
      const body = shotBodySchema.parse(req.body ?? {});
      const scheduledAt = parseDate(body.scheduled_at);
      const shot = await this.service.createShot({
        bot_slug: body.bot_slug,
        title: body.title ?? null,
        copy: body.copy,
        target: body.target,
        media_type: body.media_type,
        media_url: body.media_url ?? null,
        scheduled_at: scheduledAt,
      });
      res.status(201).json({ shot });
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async updateShot(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const body = shotUpdateSchema.parse(req.body ?? {});
      const payload: Parameters<ShotsService['updateShot']>[1] = {};
      if (body.bot_slug !== undefined) payload.bot_slug = body.bot_slug;
      if (body.title !== undefined) payload.title = body.title ?? null;
      if (body.copy !== undefined) payload.copy = body.copy;
      if (body.target !== undefined) payload.target = body.target;
      if (body.media_type !== undefined) payload.media_type = body.media_type;
      if (body.media_url !== undefined) payload.media_url = body.media_url ?? null;
      if (body.scheduled_at !== undefined) payload.scheduled_at = parseDate(body.scheduled_at);
      const shot = await this.service.updateShot(shotId, payload);
      res.json({ shot });
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async deleteShot(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      await this.service.deleteShot(shotId);
      res.status(204).send();
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async listPlans(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const plans = await this.service.listPlans(shotId);
      res.json({ plans });
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async createPlan(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const body = planBodySchema.parse(req.body ?? {});
      const plan = await this.service.createPlan(shotId, {
        name: body.name,
        price_cents: body.price_cents,
        description: body.description ?? null,
      });
      res.status(201).json({ plan });
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async updatePlan(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const planId = parseId(req.params.planId, 'planId');
      const body = planBodySchema.partial().parse(req.body ?? {});
      const payload: Parameters<ShotsService['updatePlan']>[2] = {};
      if (body.name !== undefined) payload.name = body.name;
      if (body.price_cents !== undefined) payload.price_cents = body.price_cents;
      if (body.description !== undefined) payload.description = body.description ?? null;
      const plan = await this.service.updatePlan(shotId, planId, payload);
      res.json({ plan });
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async deletePlan(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const planId = parseId(req.params.planId, 'planId');
      await this.service.deletePlan(shotId, planId);
      res.status(204).send();
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async reorderPlans(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const body = reorderSchema.parse(req.body ?? {});
      const plans = await this.service.reorderPlans(shotId, body.order);
      res.json({ plans });
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async triggerShot(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const body = triggerSchema.parse(req.body ?? {});
      const scheduledAt = parseDate(body.scheduled_at);
      const result = await this.service.triggerShot(shotId, {
        mode: body.mode,
        scheduled_at: scheduledAt,
      });
      res.json({
        mode: result.mode,
        scheduled_at: result.scheduled_at ? result.scheduled_at.toISOString() : null,
        stats: result.stats ?? null,
      });
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const stats = await this.service.getShotStats(shotId);
      res.json({ stats });
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async preview(req: Request, res: Response): Promise<void> {
    try {
      const shotId = parseId(req.params.id);
      const body = previewSchema.parse(req.body ?? {});
      const preview = await this.service.previewShot(shotId, body ?? undefined);
      res.json({ preview });
    } catch (err) {
      this.handleError(res, err);
    }
  }
}

export const shotsController = new ShotsController();

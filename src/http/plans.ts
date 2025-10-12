import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { authAdminMiddleware } from './middleware/authAdmin.js';
import { deletePlan, listPlans, upsertPlan } from '../db/plans.js';

export const plansRouter = Router();

const slugParamsSchema = z.object({
  slug: z.string().min(1, 'bot slug é obrigatório'),
});

const upsertPlanSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  plan_name: z.string().min(1, 'plan_name é obrigatório'),
  price_cents: z.coerce.number().int().min(50, 'valor mínimo: 50 centavos'),
  is_active: z.boolean().optional().default(true),
});

plansRouter.get(
  '/api/bots/:slug/plans',
  authAdminMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const parsedParams = slugParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'bot slug inválido' });
      return;
    }

    try {
      const items = await listPlans(parsedParams.data.slug);
      res.json({ items });
    } catch (err) {
      req.log?.error({ err }, '[plans] erro ao listar planos');
      const message = err instanceof Error ? err.message : 'Erro ao listar planos';
      res.status(500).json({ error: message });
    }
  }
);

plansRouter.post(
  '/api/bots/:slug/plans',
  authAdminMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const parsedParams = slugParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'bot slug inválido' });
      return;
    }

    const parsedBody = upsertPlanSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ error: 'plan_name e price_cents são obrigatórios', details: parsedBody.error.flatten() });
      return;
    }

    try {
      const saved = await upsertPlan({
        id: parsedBody.data.id,
        bot_slug: parsedParams.data.slug,
        plan_name: parsedBody.data.plan_name,
        price_cents: parsedBody.data.price_cents,
        is_active: parsedBody.data.is_active,
      });

      if (!saved) {
        res.status(404).json({ error: 'plano não encontrado' });
        return;
      }

      res.status(parsedBody.data.id ? 200 : 201).json(saved);
    } catch (err) {
      req.log?.error({ err }, '[plans] erro ao salvar plano');
      const message = err instanceof Error ? err.message : 'Erro ao salvar plano';
      res.status(500).json({ error: message });
    }
  }
);

plansRouter.delete(
  '/api/bots/:slug/plans/:id',
  authAdminMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const paramsSchema = slugParamsSchema.extend({ id: z.coerce.number().int().positive() });
    const parsedParams = paramsSchema.safeParse(req.params);

    if (!parsedParams.success) {
      res.status(400).json({ error: 'parâmetros inválidos' });
      return;
    }

    try {
      const removed = await deletePlan(parsedParams.data.id, parsedParams.data.slug);
      if (!removed) {
        res.status(404).json({ error: 'plano não encontrado' });
        return;
      }

      res.json({ ok: true });
    } catch (err) {
      req.log?.error({ err }, '[plans] erro ao excluir plano');
      const message = err instanceof Error ? err.message : 'Erro ao excluir plano';
      res.status(500).json({ error: message });
    }
  }
);

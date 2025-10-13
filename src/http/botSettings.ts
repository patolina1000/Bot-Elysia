import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { authAdminMiddleware } from './middleware/authAdmin.js';
import { getSettings, saveSettings } from '../db/botSettings.js';

export const botSettingsRouter = Router();

const slugParamsSchema = z.object({
  slug: z.string().min(1, 'bot slug é obrigatório'),
});

const saveSettingsSchema = z.object({
  pix_image_url: z
    .string()
    .trim()
    .url('pix_image_url deve ser uma URL válida')
    .max(2048, 'URL muito longa')
    .optional()
    .or(z.literal('').transform(() => undefined))
    .or(z.null())
    .optional(),
  offers_text: z
    .string()
    .trim()
    .max(1000, 'Texto muito longo')
    .optional()
    .or(z.literal('').transform(() => undefined))
    .or(z.null())
    .optional(),
  pix_downsell_text: z
    .string()
    .trim()
    .max(1000, 'Texto muito longo')
    .optional()
    .or(z.literal('').transform(() => undefined))
    .or(z.null())
    .optional(),
});

botSettingsRouter.get(
  '/api/bots/:slug/settings',
  authAdminMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const parsedParams = slugParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'bot slug inválido' });
      return;
    }

    try {
      const settings = await getSettings(parsedParams.data.slug);
      res.json(settings);
    } catch (err) {
      req.log?.error({ err }, '[bot-settings] erro ao buscar configurações');
      const message = err instanceof Error ? err.message : 'Erro ao buscar configurações';
      res.status(500).json({ error: message });
    }
  }
);

botSettingsRouter.post(
  '/api/bots/:slug/settings',
  authAdminMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const parsedParams = slugParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: 'bot slug inválido' });
      return;
    }

    const parsedBody = saveSettingsSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ error: 'pix_image_url inválido', details: parsedBody.error.flatten() });
      return;
    }

    try {
      const saved = await saveSettings(parsedParams.data.slug, {
        pix_image_url: parsedBody.data.pix_image_url ?? null,
        offers_text: parsedBody.data.offers_text ?? null,
        pix_downsell_text: parsedBody.data.pix_downsell_text ?? null,
      });

      res.json(saved);
    } catch (err) {
      req.log?.error({ err }, '[bot-settings] erro ao salvar configurações');
      const message = err instanceof Error ? err.message : 'Erro ao salvar configurações';
      res.status(500).json({ error: message });
    }
  }
);

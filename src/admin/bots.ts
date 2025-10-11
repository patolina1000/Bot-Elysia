import { Router, type Request, type Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { adminBotsDb } from './botsDb.js';

export const adminBotsRouter = Router();

adminBotsRouter.get('/admin/bots', authAdminMiddleware, async (req: Request, res: Response) => {
  try {
    const bots = await adminBotsDb.listBotsMinimal();
    res.json(bots);
  } catch (error) {
    req.log?.error({ error }, 'Failed to list admin bots');
    res.status(500).json({ error: 'failed_to_list_bots' });
  }
});

adminBotsRouter.get(
  '/admin/bots/:botId/templates/start',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { botId } = req.params;
      const template = await adminBotsDb.getStartTemplate(botId);
      if (!template) {
        res.json({ parse_mode: 'Markdown', text: '', medias: [] });
        return;
      }
      res.json(template);
    } catch (error) {
      req.log?.error({ error }, 'Failed to fetch start template');
      res.status(500).json({ error: 'failed_to_fetch_template' });
    }
  }
);
adminBotsRouter.get(
  '/admin/bots/:slug/features',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const botFeatures = await adminBotsDb.getBotFeaturesBySlug(slug);
      if (!botFeatures) {
        res.status(404).json({ error: 'bot_not_found' });
        return;
      }
      res.json(botFeatures);
    } catch (error) {
      req.log?.error({ error, slug: req.params.slug }, 'Failed to fetch bot features');
      res.status(500).json({ error: 'failed_to_fetch_features' });
    }
  }
);


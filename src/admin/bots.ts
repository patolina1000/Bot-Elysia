import { Router, type Request, type Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { adminBotsDb } from './botsDb.js';
import { telegramMediaCache } from '../services/TelegramMediaCache.js';

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

const warmupChatHandler = async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const warmupChatId = (req.body?.warmup_chat_id ?? '').toString().trim();

    if (!slug) {
      res.status(400).json({ error: 'missing_slug' });
      return;
    }

    if (!warmupChatId) {
      res.status(400).json({ error: 'warmup_chat_id_required' });
      return;
    }

    const exists = await adminBotsDb.getBotIdBySlug(slug);
    if (!exists) {
      res.status(404).json({ error: 'bot_not_found' });
      return;
    }

    await adminBotsDb.upsertWarmupChatId(slug, warmupChatId);
    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ error, slug: req.params.slug }, 'Failed to save warmup chat id');
    res.status(500).json({ error: 'failed_to_save_warmup_chat' });
  }
};

['/admin/bots/:slug/warmup-chat', '/admin/api/bots/:slug/warmup-chat'].forEach((path) => {
  adminBotsRouter.post(path, authAdminMiddleware, warmupChatHandler);
});

const warmupHandler = async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    if (!slug) {
      res.status(400).json({ error: 'missing_slug' });
      return;
    }

    const botConfig = await telegramMediaCache.findBotConfig(slug);
    if (!botConfig) {
      res.status(404).json({ error: 'bot_not_found' });
      return;
    }

    if (!botConfig.warmup_chat_id) {
      res.status(400).json({ error: 'warmup_chat_not_configured' });
      return;
    }

    if (!Array.isArray(botConfig.media_registry) || botConfig.media_registry.length === 0) {
      res.status(400).json({ error: 'media_registry_empty' });
      return;
    }

    const logger = (req as any).log ?? console;
    logger.info?.({ slug, total: botConfig.media_registry.length }, '[warmup] manual trigger start');

    const results: Array<{
      key: string;
      status: 'warm' | 'error';
      file_id?: string | null;
      file_unique_id?: string | null;
      error?: string;
    }> = [];

    for (const item of botConfig.media_registry) {
      try {
        const warmed = await telegramMediaCache.warmOne({
          bot_slug: botConfig.slug,
          token: botConfig.token,
          warmup_chat_id: botConfig.warmup_chat_id,
          item,
          logger,
        });
        results.push({
          key: item.key,
          status: 'warm',
          file_id: warmed?.file_id ?? null,
          file_unique_id: warmed?.file_unique_id ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown_error';
        logger.error?.({ slug, key: item.key, error: message }, '[warmup] item failed');
        results.push({ key: item.key, status: 'error', error: message });
      }
    }

    logger.info?.({ slug, processed: results.length }, '[warmup] manual trigger end');
    res.json({ ok: true, count: results.length, results });
  } catch (error) {
    req.log?.error({ error, slug: req.params.slug }, 'Failed to trigger warmup');
    res.status(500).json({ error: 'failed_to_trigger_warmup' });
  }
};

['/admin/bots/:slug/warmup', '/admin/api/bots/:slug/warmup'].forEach((path) => {
  adminBotsRouter.post(path, authAdminMiddleware, warmupHandler);
});

adminBotsRouter.get(
  '/admin/api/bots/:slug/media-cache',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!slug) {
        res.status(400).json({ error: 'missing_slug' });
        return;
      }
      const rows = await telegramMediaCache.listCacheForBot(slug);
      res.json({ ok: true, items: rows });
    } catch (error) {
      req.log?.error({ error, slug: req.params.slug }, 'Failed to fetch media cache');
      res.status(500).json({ error: 'failed_to_fetch_media_cache' });
    }
  }
);


import { Router, type Request, type Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { adminBotsDb } from './botsDb.js';
import { telegramMediaCache } from '../services/TelegramMediaCache.js';
import { getRecentSends, getSendStats } from '../services/TelegramSendProfiler.js';
import { pool } from '../db/pool.js';
import {
  listDownsellsByBot,
  upsertDownsell,
  deleteDownsell,
  scheduleDownsellForUser,
  getDownsellsStats,
  listVariants,
  upsertVariant,
  deleteVariant,
  type UpsertDownsellInput,
} from '../db/downsells.js';

export const adminBotsRouter = Router();

// Healthcheck do Admin Token (requer auth)
adminBotsRouter.get(
  '/admin/api/ping',
  authAdminMiddleware,
  async (_req: Request, res: Response) => {
    const r = await pool.query(`select count(*)::int as c from bots`);
    res.json({
      ok: true,
      now: new Date().toISOString(),
      botsCount: r.rows[0]?.c ?? 0,
    });
  }
);

// Lista compacta de bots para desenhar as abas
adminBotsRouter.get(
  '/admin/api/bots',
  authAdminMiddleware,
  async (_req: Request, res: Response) => {
    try {
      const r = await pool.query(
        `SELECT id, slug, name, warmup_chat_id
         FROM bots
         ORDER BY created_at DESC`
      );
      res.json({ 
        ok: true, 
        items: r.rows.map(x => ({
          id: Number(x.id), 
          slug: x.slug, 
          name: x.name ?? x.slug, 
          warmup_chat_id: x.warmup_chat_id ?? null
        })) 
      });
    } catch (error) {
      _req.log?.error({ error }, 'Failed to list bots for tabs');
      res.status(500).json({ ok: false, error: 'failed_to_list_bots' });
    }
  }
);

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

adminBotsRouter.get(
  '/admin/api/metrics/telegram-sends',
  authAdminMiddleware,
  (req: Request, res: Response) => {
    const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(400, rawLimit)) : 120;
    const items = getRecentSends(limit);
    res.json({ ok: true, items });
  }
);

adminBotsRouter.get(
  '/admin/api/metrics/telegram-sends/stats',
  authAdminMiddleware,
  (_req: Request, res: Response) => {
    const stats = getSendStats();
    res.json({ ok: true, stats });
  }
);

// ---------------- Downsells Admin API ----------------
adminBotsRouter.get(
  '/admin/api/downsells',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const botSlug = String(req.query.bot_slug ?? '').trim();
      if (!botSlug) return res.status(400).json({ ok: false, error: 'missing_bot_slug' });
      const items = await listDownsellsByBot(botSlug);
      return res.json({ ok: true, items });
    } catch (error) {
      req.log?.error({ error }, '[downsells] list failed');
      return res.status(500).json({ ok: false, error: 'downsells_list_failed' });
    }
  }
);

adminBotsRouter.post(
  '/admin/api/downsells/upsert',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<UpsertDownsellInput>;
      if (!body?.bot_slug) return res.status(400).json({ ok: false, error: 'missing_bot_slug' });
      if (!body?.trigger_kind || !['after_start','after_pix'].includes(body.trigger_kind as string)) {
        return res.status(422).json({ ok: false, error: 'invalid_trigger' });
      }
      const delay = Number(body.delay_minutes);
      if (!Number.isFinite(delay) || delay < 5 || delay > 60) {
        return res.status(422).json({ ok: false, error: 'invalid_delay' });
      }
      const price = Number(body.price_cents);
      if (!Number.isFinite(price) || price < 50) {
        return res.status(422).json({ ok: false, error: 'invalid_price' });
      }
      if (!body.title) return res.status(422).json({ ok: false, error: 'missing_title' });

      const item = await upsertDownsell({
        id: body.id,
        bot_slug: body.bot_slug,
        trigger_kind: body.trigger_kind as 'after_start' | 'after_pix',
        delay_minutes: delay,
        title: body.title,
        price_cents: price,
        message_text: body.message_text ?? null,
        media1_url: body.media1_url ?? null,
        media1_type: (body.media1_type ?? null) as any,
        media2_url: body.media2_url ?? null,
        media2_type: (body.media2_type ?? null) as any,
        window_enabled: body.window_enabled ?? false,
        window_start_hour: body.window_start_hour ?? null,
        window_end_hour: body.window_end_hour ?? null,
        window_tz: body.window_tz ?? null,
        daily_cap_per_user: body.daily_cap_per_user ?? 0,
        ab_enabled: body.ab_enabled ?? false,
        is_active: body.is_active ?? true,
      });
      return res.json({ ok: true, item });
    } catch (error) {
      req.log?.error({ error }, '[downsells] upsert failed');
      return res.status(500).json({ ok: false, error: 'downsells_upsert_failed' });
    }
  }
);

adminBotsRouter.delete(
  '/admin/api/downsells/:id',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const botSlug = String(req.query.bot_slug ?? '').trim();
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      if (!botSlug) return res.status(400).json({ ok: false, error: 'missing_bot_slug' });
      const ok = await deleteDownsell(id, botSlug);
      return res.json({ ok });
    } catch (error) {
      req.log?.error({ error }, '[downsells] delete failed');
      return res.status(500).json({ ok: false, error: 'downsells_delete_failed' });
    }
  }
);

// Envio imediato para teste (agenda para agora)
adminBotsRouter.post(
  '/admin/api/downsells/test-send',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const body = req.body as any;
      const downsell_id = Number(body?.downsell_id);
      const bot_slug = String(body?.bot_slug ?? '').trim();
      const telegram_id = Number(body?.telegram_id);
      if (!Number.isFinite(downsell_id)) return res.status(422).json({ ok: false, error: 'invalid_downsell_id' });
      if (!bot_slug) return res.status(422).json({ ok: false, error: 'missing_bot_slug' });
      if (!Number.isFinite(telegram_id)) return res.status(422).json({ ok: false, error: 'invalid_telegram_id' });
      const item = await scheduleDownsellForUser({
        downsell_id,
        bot_slug,
        telegram_id,
        scheduled_at: new Date(),
      });
      return res.json({ ok: true, item });
    } catch (error) {
      req.log?.error({ error }, '[downsells] test-send failed');
      return res.status(500).json({ ok: false, error: 'downsells_test_send_failed' });
    }
  }
);

// Métricas por downsell (mini dashboard)
adminBotsRouter.get(
  '/admin/api/downsells/metrics',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const botSlug = String(req.query.bot_slug ?? '').trim();
      if (!botSlug) return res.status(400).json({ ok: false, error: 'missing_bot_slug' });
      const stats = await getDownsellsStats(botSlug);
      return res.json({ ok: true, stats });
    } catch (error) {
      req.log?.error({ error }, '[downsells] metrics failed');
      return res.status(500).json({ ok: false, error: 'downsells_metrics_failed' });
    }
  }
);

// Listar variantes A/B de um downsell
adminBotsRouter.get('/admin/api/downsells/variants', authAdminMiddleware, async (req: Request, res: Response)=>{
  try {
    const downsell_id = Number(req.query.downsell_id);
    if (!Number.isFinite(downsell_id)) return res.status(422).json({ ok:false, error:'invalid_downsell_id' });
    const items = await listVariants(downsell_id);
    return res.json({ ok:true, items });
  } catch (error) {
    req.log?.error({ error }, '[downsells] list variants failed');
    return res.status(500).json({ ok: false, error: 'downsells_list_variants_failed' });
  }
});

// Upsert variante
adminBotsRouter.post('/admin/api/downsells/variants/upsert', authAdminMiddleware, async (req: Request, res: Response)=>{
  try {
    const b = req.body || {};
    const downsell_id = Number(b.downsell_id);
    const key = String(b.key) as 'A'|'B';
    const weight = Number(b.weight ?? 50);
    if (!Number.isFinite(downsell_id) || !['A','B'].includes(key)) return res.status(422).json({ ok:false, error:'invalid_payload' });
    const item = await upsertVariant({
      id: b.id ? Number(b.id) : undefined,
      downsell_id, key, weight,
      title: b.title ?? null,
      price_cents: b.price_cents ?? null,
      message_text: b.message_text ?? null,
      media1_url: b.media1_url ?? null,
      media1_type: b.media1_type ?? null,
      media2_url: b.media2_url ?? null,
      media2_type: b.media2_type ?? null,
    });
    return res.json({ ok:true, item });
  } catch (error) {
    req.log?.error({ error }, '[downsells] upsert variant failed');
    return res.status(500).json({ ok: false, error: 'downsells_upsert_variant_failed' });
  }
});

// Deletar variante
adminBotsRouter.delete('/admin/api/downsells/variants', authAdminMiddleware, async (req: Request, res: Response)=>{
  try {
    const downsell_id = Number(req.query.downsell_id);
    const key = String(req.query.key) as 'A'|'B';
    if (!Number.isFinite(downsell_id) || !['A','B'].includes(key)) return res.status(422).json({ ok:false, error:'invalid_params' });
    const ok = await deleteVariant(downsell_id, key);
    return res.json({ ok });
  } catch (error) {
    req.log?.error({ error }, '[downsells] delete variant failed');
    return res.status(500).json({ ok: false, error: 'downsells_delete_variant_failed' });
  }
});


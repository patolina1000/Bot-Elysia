import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authAdminMiddleware } from './middleware/authAdmin.js';
import { botRegistry } from '../services/BotRegistry.js';
import { webhookService } from '../services/WebhookService.js';
import { startService } from '../telegram/features/start/startService.js';
import { offerService } from '../services/OfferService.js';
import { funnelService } from '../services/FunnelService.js';
import { pool } from '../db/pool.js';
import { funnelApiRouter } from '../analytics/FunnelApi.js';
import { pushinpayRouter, pushinpayWebhookRouter } from './payments/pushinpay.js';
import { plansRouter } from './plans.js';
import { botSettingsRouter } from './botSettings.js';
import { miniappQrRouter } from './miniapp/qr.js';
import { uploadR2Router } from './uploadR2.js';
import { adminShotsRouter } from '../api/admin/shots.routes.js';
import { buildPixDiag, buildPixDiagForAll } from '../services/payments/pixDiagnostics.js';

export const router = Router();

// Health check
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Admin routes (protected)
const adminRouter = Router();
adminRouter.use(authAdminMiddleware);

// POST /admin/bots
const createBotSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  token: z.string().min(10),
  webhook_secret: z.string().min(8),
  features: z.record(z.boolean()).optional(),
  allowed_updates: z.array(z.string()).optional(),
});

adminRouter.post('/bots', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = createBotSchema.parse(req.body);

    // Create bot
    const { id, slug } = await botRegistry.createBot({
      slug: body.slug,
      name: body.name,
      token: body.token,
      webhook_secret: body.webhook_secret,
      features: body.features || { 'core-start': true, funnels: true },
    });

    // Register webhook
    await webhookService.registerWebhook({
      token: body.token,
      slug: body.slug,
      webhook_secret: body.webhook_secret,
      allowed_updates: body.allowed_updates,
    });

    res.status(201).json({ bot_id: id, slug });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    req.log?.error({ err }, 'Error creating bot');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /admin/bots/:id/templates/start
const updateStartTemplateSchema = z.object({
  text: z.string().min(1),
  parse_mode: z.enum(['Markdown', 'HTML']).default('Markdown'),
  start_messages: z
    .array(z.string())
    .max(3, 'Máximo de 3 mensagens iniciais')
    .optional(),
  media: z
    .array(
      z.object({
        type: z.enum(['photo', 'video', 'audio']),
        media: z.string().url(),
      })
    )
    .optional()
    .default([]),
});

adminRouter.put('/bots/:id/templates/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const body = updateStartTemplateSchema.parse(req.body);

    await startService.saveStartTemplate(
      id,
      body.text,
      body.parse_mode,
      body.media,
      body.start_messages
    );

    res.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    req.log?.error({ err }, 'Error updating start template');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/offers
const createOfferSchema = z.object({
  bot_id: z.string().uuid(),
  name: z.string().min(1),
  price_cents: z.number().int().positive(),
  currency: z.string().default('BRL'),
  metadata: z.record(z.any()).optional(),
});

adminRouter.post('/offers', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = createOfferSchema.parse(req.body);

    const offerId = await offerService.createOffer(body);

    res.status(201).json({ offer_id: offerId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    req.log?.error({ err }, 'Error creating offer');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/checkout/start (stub for web funnel)
const checkoutStartSchema = z.object({
  bot_slug: z.string(),
  tg_user_id: z.number().optional(),
  offer_id: z.string().uuid().optional(),
  meta: z.record(z.any()).optional(),
});

adminRouter.post('/checkout/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = checkoutStartSchema.parse(req.body);

    const botConfig = await botRegistry.getBotBySlug(body.bot_slug);
    if (!botConfig) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    const eventId = body.tg_user_id
      ? funnelService.generateCheckoutStartEventId(botConfig.id, body.tg_user_id)
      : `checkout:${botConfig.id}:web:${Date.now()}`;

    await funnelService.createEvent({
      bot_id: botConfig.id,
      tg_user_id: body.tg_user_id,
      event: 'checkout_start',
      event_id: eventId,
      meta: body.meta,
    });

    res.status(201).json({ event_id: eventId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    req.log?.error({ err }, 'Error creating checkout start event');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.get('/diag/pix', async (req: Request, res: Response): Promise<void> => {
  try {
    const botSlug = (req.query.bot as string | undefined) ?? (req.query.slug as string | undefined);
    if (!botSlug) {
      res.status(400).json({ error: 'Missing bot slug' });
      return;
    }

    const diag = await buildPixDiag(botSlug);
    if (!diag) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    res.json(diag);
  } catch (err) {
    req.log?.error({ err }, '[PIX][DIAG] failed to build diagnostics');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.get('/diag/pix/all', async (_req: Request, res: Response): Promise<void> => {
  try {
    const diagnostics = await buildPixDiagForAll();
    res.json({ bots: diagnostics });
  } catch (err) {
    _req.log?.error({ err }, '[PIX][DIAG] failed to build diagnostics');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/logs
adminRouter.get('/logs', async (req: Request, res: Response) => {
  try {
    const bot_id = req.query.bot_id as string | undefined;
    const level = req.query.level as string | undefined;
    const request_id = req.query.request_id as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 50;

    const offset = (page - 1) * pageSize;

    const logsResult = await pool.query(
      `SELECT * FROM app_logs
       WHERE ($1::UUID IS NULL OR bot_id = $1)
         AND ($2::TEXT IS NULL OR level = $2)
         AND ($3::UUID IS NULL OR request_id = $3)
       ORDER BY created_at DESC
       LIMIT $4 OFFSET $5`,
      [bot_id || null, level || null, request_id || null, pageSize, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM app_logs
       WHERE ($1::UUID IS NULL OR bot_id = $1)
         AND ($2::TEXT IS NULL OR level = $2)
         AND ($3::UUID IS NULL OR request_id = $3)`,
      [bot_id || null, level || null, request_id || null]
    );

    const total = parseInt(countResult.rows[0].count, 10);

    res.json({
      logs: logsResult.rows,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    req.log?.error({ err }, 'Error fetching logs');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.use('/admin', adminRouter);
router.use('/api', adminShotsRouter);
router.use(plansRouter);
router.use(botSettingsRouter);
router.use(pushinpayRouter);
router.use(pushinpayWebhookRouter);

// Upload R2 (admin)
router.use(uploadR2Router);

// Mini App (QR viewer)
router.use(miniappQrRouter);

// Analytics routes (no auth for now, but can be protected)
router.use('/analytics', funnelApiRouter);

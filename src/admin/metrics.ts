import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { telegramContactsService } from '../services/TelegramContactsService.js';

export const adminMetricsRouter = Router();

const chatMetricsSchema = z.object({
  bot_slug: z.string().min(1),
  days: z.coerce.number().int().positive().default(30),
});

/**
 * GET /admin/metrics/chats
 * 
 * Returns chat metrics for a specific bot based on telegram_contacts table:
 * - active: contacts with chat_state='active' and last interaction within window
 * - blocked: contacts with chat_state IN ('blocked', 'deactivated')
 * - unknown: all other contacts (no interaction in window or state=unknown)
 */
adminMetricsRouter.get(
  '/admin/metrics/chats',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const params = chatMetricsSchema.parse(req.query);
      const { bot_slug, days } = params;

      const metrics = await telegramContactsService.getMetrics(bot_slug, days);

      res.status(200).json({
        ok: true,
        bot_slug,
        window_days: days,
        active: metrics.active,
        blocked: metrics.blocked,
        unknown: metrics.unknown,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ 
          error: 'validation_error', 
          details: err.errors 
        });
        return;
      }
      req.log?.error({ err, query: req.query }, 'Failed to get chat metrics');
      res.status(500).json({ error: 'metrics_failed' });
    }
  }
);

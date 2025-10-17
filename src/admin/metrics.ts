import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { pool } from '../db/pool.js';

export const adminMetricsRouter = Router();

const chatMetricsSchema = z.object({
  bot_slug: z.string().min(1),
  days: z.coerce.number().int().positive().default(30),
});

/**
 * GET /admin/metrics/chats
 * 
 * Returns chat metrics for a specific bot:
 * - active: users with last interaction within the specified window
 * - blocked: placeholder (always 0 for now)
 * - unknown: total distinct users minus active
 */
adminMetricsRouter.get(
  '/admin/metrics/chats',
  authAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const params = chatMetricsSchema.parse(req.query);
      const { bot_slug, days } = params;

      // First, get bot_id from slug
      const botResult = await pool.query(
        'SELECT id FROM bots WHERE slug = $1',
        [bot_slug]
      );

      if (botResult.rows.length === 0) {
        res.status(404).json({ error: 'bot_not_found' });
        return;
      }

      const bot_id = botResult.rows[0].id;

      // Calculate the window cutoff date
      const windowCutoff = new Date();
      windowCutoff.setDate(windowCutoff.getDate() - days);

      // Get last interaction per user
      // Group by tg_user_id and get max(occurred_at) for each user
      const metricsQuery = `
        WITH user_last_interaction AS (
          SELECT 
            tg_user_id,
            MAX(COALESCE(occurred_at, created_at)) as last_interaction
          FROM funnel_events
          WHERE bot_id = $1
            AND tg_user_id IS NOT NULL
          GROUP BY tg_user_id
        )
        SELECT
          COUNT(DISTINCT tg_user_id) as total_users,
          COUNT(DISTINCT CASE 
            WHEN last_interaction >= $2 THEN tg_user_id 
            ELSE NULL 
          END) as active_users
        FROM user_last_interaction
      `;

      const metricsResult = await pool.query(metricsQuery, [bot_id, windowCutoff]);
      
      const row = metricsResult.rows[0];
      const total = parseInt(row.total_users || '0', 10);
      const active = parseInt(row.active_users || '0', 10);
      const blocked = 0; // Placeholder
      const unknown = total - active;

      res.status(200).json({
        ok: true,
        bot_slug,
        window_days: days,
        active,
        blocked,
        unknown,
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

import type { Express, Request, Response } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

export function registerAdminPlansRoutes(app: Express): void {
  app.get(
    '/admin/api/plans',
    authAdminMiddleware,
    async (req: Request, res: Response): Promise<Response> => {
      try {
        const botSlugRaw = req.query?.bot_slug;
        const botSlug = typeof botSlugRaw === 'string' ? botSlugRaw.trim().toLowerCase() : '';
        if (!botSlug) {
          return res.status(400).json({ ok: false, error: 'bot_slug obrigatório' });
        }

        const { rows } = await pool.query(
          `SELECT id, name, price_cents, is_active
             FROM bot_plans
            WHERE bot_slug = $1
            ORDER BY sort_order NULLS LAST, id ASC`,
          [botSlug]
        );

        return res.json({ items: rows });
      } catch (err) {
        logger.error({ err }, '[ADMIN][PLANS][GET] error');
        return res.status(500).json({ ok: false, error: 'internal_error' });
      }
    }
  );
}

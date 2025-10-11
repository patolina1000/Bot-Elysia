import { Request, Response, NextFunction } from 'express';
import { env } from '../../env.js';

export function authAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.substring(7);

  if (token !== env.ADMIN_API_TOKEN) {
    res.status(403).json({ error: 'Invalid admin token' });
    return;
  }

  next();
}

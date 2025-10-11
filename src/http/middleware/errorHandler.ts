import { Request, Response, NextFunction } from 'express';
import { logger } from '../../logger.js';
import { ZodError } from 'zod';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error({
    err,
    requestId: req.requestId,
    url: req.url,
    method: req.method,
  }, 'Request error');

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation error',
      details: err.errors,
    });
    return;
  }

  res.status(500).json({
    error: 'Internal server error',
    requestId: req.requestId,
  });
}

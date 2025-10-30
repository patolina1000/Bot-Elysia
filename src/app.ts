import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './logger.js';
import { requestIdMiddleware } from './http/middleware/requestId.js';
import { errorHandler } from './http/middleware/errorHandler.js';
import { router } from './http/routes.js';
import { webhookRouter } from './telegram/webhookRouter.js';
import { mountAdminUpload } from './admin/upload.js';
import { adminBotsRouter } from './admin/bots.js';
import { createBotRouter } from './admin/createBot.js';
import { registerAdminDownsellsRoutes } from './admin/downsells.js';
import { registerAdminPlansRoutes } from './admin/plans.js';
import { legacyAdminShotsRouter } from './admin/shots.js';
import { adminMetricsRouter } from './admin/metrics.js';

export function createApp() {
  const app = express();

  // Middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request ID middleware
  app.use(requestIdMiddleware);

  // Logging middleware
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
      customProps: (req) => ({
        requestId: (req as any).requestId,
      }),
    })
  );

  // Serve static files (admin wizard)
  app.use(express.static('public'));
  mountAdminUpload(app);
  app.use(createBotRouter);
  app.use(adminBotsRouter);
  app.use(adminMetricsRouter);
  registerAdminDownsellsRoutes(app);
  registerAdminPlansRoutes(app);
  // Legacy admin shots routes simply adapt to the REST controller.
  app.use('/admin/api/shots', legacyAdminShotsRouter);

  // Routes
  app.use(webhookRouter);
  app.use(router);

  // Error handler
  app.use(errorHandler);

  return app;
}

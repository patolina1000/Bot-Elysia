import { Router } from 'express';
import { adminAuthMiddleware } from '../middleware/adminAuth.js';
import { ShotsController } from './shots.controller.js';

const controller = new ShotsController();

function wrap(handler: (req: any, res: any) => Promise<any>) {
  return (req: any, res: any, next: any) => {
    handler.call(controller, req, res).catch(next);
  };
}

export const adminShotsRouter = Router();

adminShotsRouter.use(adminAuthMiddleware);

adminShotsRouter.get('/shots', wrap(controller.listShots));
adminShotsRouter.get('/shots/:id', wrap(controller.getShot));
adminShotsRouter.post('/shots', wrap(controller.createShot));
adminShotsRouter.put('/shots/:id', wrap(controller.updateShot));
adminShotsRouter.delete('/shots/:id', wrap(controller.deleteShot));

adminShotsRouter.get('/shots/:id/plans', wrap(controller.listPlans));
adminShotsRouter.post('/shots/:id/plans', wrap(controller.createPlan));
adminShotsRouter.put('/shots/:id/plans/:planId', wrap(controller.updatePlan));
adminShotsRouter.delete('/shots/:id/plans/:planId', wrap(controller.deletePlan));
adminShotsRouter.post('/shots/:id/plans/reorder', wrap(controller.reorderPlans));

adminShotsRouter.post('/shots/:id/trigger', wrap(controller.triggerShot));
adminShotsRouter.get('/shots/:id/stats', wrap(controller.getStats));
adminShotsRouter.post('/shots/:id/preview', wrap(controller.preview));

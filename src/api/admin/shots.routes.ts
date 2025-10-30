import { Router, type Request, type Response, type NextFunction } from 'express';
import { authAdminMiddleware } from '../../http/middleware/authAdmin.js';
import {
  createPlan,
  createShot,
  deletePlan,
  deleteShot,
  getShot,
  getStats,
  listPlans,
  listShots,
  previewShot,
  reorderPlans,
  triggerShot,
  updatePlan,
  updateShot,
} from './shots.controller.js';

export const adminShotsRouter = Router();

adminShotsRouter.use(authAdminMiddleware);

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

const basePaths = ['/admin/shots', '/shots'];

for (const path of basePaths) {
  adminShotsRouter.get(path, wrap(listShots));
  adminShotsRouter.post(path, wrap(createShot));
}

for (const path of basePaths) {
  adminShotsRouter.get(`${path}/:id`, wrap(getShot));
  adminShotsRouter.put(`${path}/:id`, wrap(updateShot));
  adminShotsRouter.delete(`${path}/:id`, wrap(deleteShot));

  adminShotsRouter.get(`${path}/:id/plans`, wrap(listPlans));
  adminShotsRouter.post(`${path}/:id/plans`, wrap(createPlan));
  adminShotsRouter.put(`${path}/:id/plans/:planId`, wrap(updatePlan));
  adminShotsRouter.delete(`${path}/:id/plans/:planId`, wrap(deletePlan));
  adminShotsRouter.post(`${path}/:id/plans/reorder`, wrap(reorderPlans));

  adminShotsRouter.post(`${path}/:id/trigger`, wrap(triggerShot));
  adminShotsRouter.get(`${path}/:id/stats`, wrap(getStats));
  adminShotsRouter.post(`${path}/:id/preview`, wrap(previewShot));
}

const scheduleHandler = wrap(async (req, res) => {
  req.body = { ...(req.body ?? {}), mode: 'schedule' };
  await triggerShot(req, res);
});

adminShotsRouter.post('/admin/shots/:id/schedule', scheduleHandler);
adminShotsRouter.post('/shots/:id/schedule', scheduleHandler);

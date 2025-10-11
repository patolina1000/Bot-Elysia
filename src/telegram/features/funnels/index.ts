import { Composer } from 'grammy';
import { MyContext } from '../../grammYContext.js';

export const funnelsFeature = new Composer<MyContext>();

// Stub: Funnel event handlers will be registered here
// Events: checkout_start, pix_created, purchase_paid
// These will be triggered via admin APIs or external webhooks

funnelsFeature.use(async (_ctx, next) => {
  // Middleware for funnel tracking (if needed)
  await next();
});

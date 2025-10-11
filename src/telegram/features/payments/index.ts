import { Composer } from 'grammy';
import { MyContext } from '../../grammYContext.js';

export const paymentsFeature = new Composer<MyContext>();

// Stub: Payment integration
// This will handle payment webhooks and commands in the future
// For now, this is just a placeholder

paymentsFeature.use(async (_ctx, next) => {
  // Payment middleware (if needed)
  await next();
});

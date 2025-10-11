import { Composer } from 'grammy';
import { MyContext } from '../../grammYContext.js';

export const broadcastFeature = new Composer<MyContext>();

// Stub: Broadcast functionality
// Admin command to trigger broadcasts will be added here
// For now, this is just a placeholder

broadcastFeature.use(async (_ctx, next) => {
  // Broadcast middleware (if needed)
  await next();
});

import type { Logger } from 'pino';
import { listDownsellsByBot, scheduleDownsellForUser } from '../../db/downsells.js';

export type DownsellTrigger = 'after_start' | 'after_pix';

export async function scheduleTriggeredDownsells(params: {
  bot_slug: string;
  telegram_id: number;
  trigger: DownsellTrigger;
  logger?: Logger;
}) {
  const { bot_slug, telegram_id, trigger, logger } = params;
  const all = await listDownsellsByBot(bot_slug);
  const items = all.filter((d) => d.is_active && d.trigger_kind === trigger);

  for (const d of items) {
    const when = new Date(Date.now() + d.delay_minutes * 60_000);
    try {
      await scheduleDownsellForUser({
        downsell_id: d.id,
        bot_slug,
        telegram_id,
        scheduled_at: when,
      });
      logger?.info(
        { bot_slug, downsell_id: d.id, telegram_id, trigger, scheduled_at: when.toISOString() },
        '[DOWNSELL][SCHEDULED]'
      );
    } catch (err) {
      logger?.warn(
        { bot_slug, downsell_id: d.id, telegram_id, trigger, err },
        '[DOWNSELL][SCHEDULE_ERROR]'
      );
    }
  }
}

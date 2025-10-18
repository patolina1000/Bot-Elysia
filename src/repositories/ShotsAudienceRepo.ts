import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

type TelegramRow = {
  telegram_id: string | number | bigint | null;
};

function mapTelegramIds(rows: TelegramRow[]): bigint[] {
  const ids: bigint[] = [];

  for (const row of rows) {
    const value = row.telegram_id;
    if (value === null || value === undefined) {
      continue;
    }

    try {
      ids.push(BigInt(value));
    } catch {
      continue;
    }
  }

  return ids;
}

async function fetchTelegramIds(
  botSlug: string,
  target: string,
  eventCondition: string
): Promise<bigint[]> {
  const result = await pool.query(
    `SELECT DISTINCT fe.telegram_id
     FROM funnel_events fe
     LEFT JOIN payload_tracking pt
       ON pt.telegram_id = fe.telegram_id
       OR (fe.payload_id IS NOT NULL AND pt.payload_id = fe.payload_id)
     WHERE fe.telegram_id IS NOT NULL
       AND COALESCE(fe.meta->>'bot_slug', pt.bot_slug) = $1
       AND ${eventCondition}`,
    [botSlug]
  );

  const telegramIds = mapTelegramIds(result.rows as TelegramRow[]);

  logger.debug(
    `[SHOTS][AUDIENCE] target=${target} bot=${botSlug} candidates=${telegramIds.length} join="OR"`
  );

  return telegramIds;
}

export function getTelegramIdsForAllStarted(botSlug: string): Promise<bigint[]> {
  return fetchTelegramIds(botSlug, 'all_started', "fe.event_name = 'bot_start'");
}

export function getTelegramIdsForPixGenerated(botSlug: string): Promise<bigint[]> {
  return fetchTelegramIds(
    botSlug,
    'pix_generated',
    "fe.event_name IN ('pix_created', 'purchase')"
  );
}

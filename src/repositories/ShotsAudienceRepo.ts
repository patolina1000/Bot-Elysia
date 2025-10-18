import { pool } from '../db/pool.js';

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
  eventCondition: string
): Promise<bigint[]> {
  const result = await pool.query(
    `SELECT DISTINCT fe.telegram_id
     FROM funnel_events fe
     LEFT JOIN payload_tracking pt ON fe.telegram_id = pt.telegram_id
     WHERE fe.telegram_id IS NOT NULL
       AND COALESCE(fe.meta->>'bot_slug', pt.bot_slug) = $1
       AND ${eventCondition}`,
    [botSlug]
  );

  return mapTelegramIds(result.rows as TelegramRow[]);
}

export function getTelegramIdsForAllStarted(botSlug: string): Promise<bigint[]> {
  return fetchTelegramIds(botSlug, "fe.event_name = 'bot_start'");
}

export function getTelegramIdsForPixGenerated(botSlug: string): Promise<bigint[]> {
  return fetchTelegramIds(botSlug, "fe.event_name IN ('pix_created','purchase')");
}

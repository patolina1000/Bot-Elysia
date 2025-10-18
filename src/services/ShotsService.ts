import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import {
  getTelegramIdsForAllStarted,
  getTelegramIdsForPixGenerated,
} from '../repositories/ShotsAudienceRepo.js';

const INSERT_BATCH_SIZE = 500;

export type NormalizedShotTarget = 'all_started' | 'pix_generated';

interface ShotRow {
  id: number;
  bot_slug: string;
  target: string | null;
  scheduled_at: Date | string | null;
}

export interface EnqueueShotRecipientsResult {
  candidates: number;
  inserted: number;
  duplicates: number;
}

function normalizeShotTarget(target: string | null): NormalizedShotTarget {
  switch (target) {
    case 'all_started':
    case 'started':
      return 'all_started';
    case 'pix_generated':
    case 'pix_created':
      return 'pix_generated';
    default:
      throw new Error(`Unsupported shot target: ${target ?? 'null'}`);
  }
}

function normalizeScheduledAt(value: Date | string | null): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  if (value && typeof (value as any).toISOString === 'function') {
    const parsed = new Date((value as any).toISOString());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

async function fetchShot(shotId: number): Promise<ShotRow> {
  const { rows } = await pool.query<ShotRow>(
    `SELECT id, bot_slug, target, scheduled_at
     FROM shots
     WHERE id = $1
     LIMIT 1`,
    [shotId]
  );

  if (rows.length === 0) {
    throw new Error(`Shot not found for id ${shotId}`);
  }

  return rows[0];
}

async function fetchAudience(
  botSlug: string,
  target: NormalizedShotTarget
): Promise<bigint[]> {
  if (target === 'all_started') {
    return getTelegramIdsForAllStarted(botSlug);
  }
  return getTelegramIdsForPixGenerated(botSlug);
}

export class ShotsService {
  async enqueueShotRecipients(shotId: number): Promise<EnqueueShotRecipientsResult> {
    if (!Number.isInteger(shotId) || shotId <= 0) {
      throw new Error('shotId must be a positive integer');
    }

    const shotRow = await fetchShot(shotId);

    const target = normalizeShotTarget(shotRow.target);
    const scheduledAt = normalizeScheduledAt(shotRow.scheduled_at);
    const botSlug = shotRow.bot_slug;

    const shotLogger = logger.child({
      scope: 'ShotsService',
      shot_id: shotId,
      bot_slug: botSlug,
      target,
    });

    const audience = await fetchAudience(botSlug, target);
    const candidates = audience.length;

    shotLogger.info({ candidates }, '[SHOTS][QUEUE] candidatos carregados');

    if (candidates === 0) {
      shotLogger.info(
        { candidates: 0, inserted: 0, duplicates: 0 },
        '[SHOTS][QUEUE] nenhum candidato para enfileirar'
      );
      return { candidates: 0, inserted: 0, duplicates: 0 };
    }

    let inserted = 0;

    for (let i = 0; i < audience.length; i += INSERT_BATCH_SIZE) {
      const chunk = audience.slice(i, i + INSERT_BATCH_SIZE);
      if (chunk.length === 0) {
        continue;
      }

      const chunkResult = await pool.query(
        `INSERT INTO shots_queue (
           shot_id,
           bot_slug,
           telegram_id,
           status,
           attempts,
           scheduled_at,
           next_retry_at
         )
         SELECT
           $1 AS shot_id,
           $2 AS bot_slug,
           telegram_id,
           'pending' AS status,
           0 AS attempts,
           $3 AS scheduled_at,
           NULL::timestamptz AS next_retry_at
         FROM unnest($4::bigint[]) AS t(telegram_id)
         ON CONFLICT (shot_id, telegram_id) DO NOTHING`,
        [shotId, botSlug, scheduledAt, chunk.map((id) => id.toString())]
      );

      const insertedInChunk = chunkResult.rowCount ?? 0;
      inserted += insertedInChunk;

      shotLogger.debug(
        {
          chunk_start: i,
          chunk_size: chunk.length,
          inserted: insertedInChunk,
        },
        '[SHOTS][QUEUE] lote inserido'
      );
    }

    const duplicates = Math.max(0, candidates - inserted);

    shotLogger.info(
      { candidates, inserted, duplicates },
      '[SHOTS][QUEUE] enfileiramento concluído'
    );

    return { candidates, inserted, duplicates };
  }
}

export const shotsService = new ShotsService();

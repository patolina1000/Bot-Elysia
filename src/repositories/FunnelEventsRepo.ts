import { pool } from '../db/pool.js';

export type ShotEventTarget = 'all_started' | 'pix_generated';

function buildShotSentEventId(shotId: number, telegramId: bigint): string {
  return `shs:${shotId}:${telegramId.toString()}`;
}

function normalizeAttempt(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt <= 0) {
    return 1;
  }
  return attempt;
}

function buildShotErrorEventId(shotId: number, telegramId: bigint, attempt: number): string {
  const safeAttempt = normalizeAttempt(attempt);
  return `she:${shotId}:${telegramId.toString()}:${safeAttempt}`;
}

function sanitizeError(errorMessage?: string): string | undefined {
  const trimmed = errorMessage?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= 500) {
    return trimmed;
  }
  return trimmed.slice(0, 500);
}

async function insertFunnelEvent(params: {
  eventId: string;
  eventName: 'shot_sent' | 'shot_error';
  telegramId: bigint;
  meta: Record<string, unknown>;
}): Promise<void> {
  const telegramIdParam = params.telegramId.toString();
  await pool.query(
    `INSERT INTO funnel_events (event_id, event_name, telegram_id, meta)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (event_id) DO NOTHING`,
    [params.eventId, params.eventName, telegramIdParam, JSON.stringify(params.meta)]
  );
}

export class FunnelEventsRepo {
  static async insertShotSent(params: {
    shotId: number;
    botSlug: string;
    telegramId: bigint;
    target: ShotEventTarget;
  }): Promise<void> {
    const eventId = buildShotSentEventId(params.shotId, params.telegramId);
    const meta = {
      shot_id: params.shotId,
      bot_slug: params.botSlug,
      target: params.target,
    };

    await insertFunnelEvent({
      eventId,
      eventName: 'shot_sent',
      telegramId: params.telegramId,
      meta,
    });
  }

  static async insertShotError(params: {
    shotId: number;
    botSlug: string;
    telegramId: bigint;
    target: ShotEventTarget;
    attempt: number;
    errorMessage?: string;
  }): Promise<void> {
    const attempt = normalizeAttempt(params.attempt);
    const eventId = buildShotErrorEventId(params.shotId, params.telegramId, attempt);
    const sanitizedError = sanitizeError(params.errorMessage);
    const meta: Record<string, unknown> = {
      shot_id: params.shotId,
      bot_slug: params.botSlug,
      target: params.target,
      attempt,
    };

    if (sanitizedError) {
      meta.error = sanitizedError;
    }

    await insertFunnelEvent({
      eventId,
      eventName: 'shot_error',
      telegramId: params.telegramId,
      meta,
    });
  }
}

export const __private__ = {
  buildShotSentEventId,
  buildShotErrorEventId,
  sanitizeError,
  normalizeAttempt,
};

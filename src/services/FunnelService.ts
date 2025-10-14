import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

export interface CreateEventParams {
  bot_id: string | null;
  tg_user_id?: number;
  event: string;
  event_id: string;
  price_cents?: number;
  transaction_id?: string;
  payload_id?: string | number | null;
  meta?: Record<string, any>;
}

export interface FunnelEvent {
  id: number;
  bot_id: string | null;
  tg_user_id: number | null;
  event: string;
  event_id: string;
  price_cents: number | null;
  transaction_id: string | null;
  meta: Record<string, any> | null;
  created_at: Date;
}

export class FunnelService {
  async createEvent(params: CreateEventParams): Promise<FunnelEvent | null> {
    try {
      const result = await pool.query(
        `INSERT INTO funnel_events (bot_id, tg_user_id, event, event_id, price_cents, transaction_id, payload_id, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING *`,
        [
          params.bot_id,
          params.tg_user_id || null,
          params.event,
          params.event_id,
          params.price_cents || null,
          params.transaction_id || null,
          params.payload_id ?? null,
          params.meta ? JSON.stringify(params.meta) : null,
        ]
      );

      if (result.rows.length === 0) {
        // Event already exists (conflict)
        logger.debug({ event_id: params.event_id }, 'Event already exists (idempotent)');
        return null;
      }

      logger.info({ event: params.event, event_id: params.event_id, payload_id: params.payload_id ?? null }, 'Funnel event created');

      return result.rows[0];
    } catch (err) {
      logger.error({ err, params }, 'Failed to create funnel event');
      throw err;
    }
  }

  async getEventById(eventId: string): Promise<FunnelEvent | null> {
    const result = await pool.query(
      `SELECT * FROM funnel_events WHERE event_id = $1`,
      [eventId]
    );

    return result.rows[0] || null;
  }

  async upsertUser(botId: string, tgUserId: number): Promise<void> {
    await pool.query(
      `INSERT INTO users (bot_id, tg_user_id, first_seen_at, last_seen_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (bot_id, tg_user_id) 
       DO UPDATE SET last_seen_at = now()`,
      [botId, tgUserId]
    );
  }

  generateStartEventId(botId: string, tgUserId: number): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T.Z]/g, '').substring(0, 14);
    return `st:${botId}:${tgUserId}:${timestamp}`;
  }

  generateCheckoutStartEventId(botId: string, tgUserId: number): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T.Z]/g, '').substring(0, 14);
    return `checkout:${botId}:${tgUserId}:${timestamp}`;
  }
}

export const funnelService = new FunnelService();

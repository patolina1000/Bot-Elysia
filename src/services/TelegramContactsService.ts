import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

export type ChatState = 'active' | 'blocked' | 'deactivated' | 'unknown';

export interface TelegramContact {
  bot_slug: string;
  telegram_id: number;
  chat_state: ChatState;
  first_seen_at: Date;
  last_interaction_at: Date | null;
  blocked_at: Date | null;
  unblocked_at: Date | null;
  updated_at: Date;
  username?: string | null;
  language_code?: string | null;
  is_premium?: boolean | null;
}

export interface UpsertContactParams {
  bot_slug: string;
  telegram_id: number;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export class TelegramContactsService {
  /**
   * Upsert contact on user interaction
   * Sets state to 'active' and updates last_interaction_at
   */
  async upsertOnInteraction(params: UpsertContactParams): Promise<void> {
    const { bot_slug, telegram_id, username, language_code, is_premium } = params;

    try {
      await pool.query(
        `INSERT INTO telegram_contacts (
          bot_slug, 
          telegram_id, 
          chat_state, 
          first_seen_at, 
          last_interaction_at,
          username,
          language_code,
          is_premium
        )
        VALUES ($1, $2, 'active', now(), now(), $3, $4, $5)
        ON CONFLICT (bot_slug, telegram_id) 
        DO UPDATE SET
          chat_state = CASE 
            WHEN telegram_contacts.chat_state IN ('unknown', 'blocked') THEN 'active'::chat_state_enum
            ELSE telegram_contacts.chat_state
          END,
          last_interaction_at = now(),
          username = COALESCE($3, telegram_contacts.username),
          language_code = COALESCE($4, telegram_contacts.language_code),
          is_premium = COALESCE($5, telegram_contacts.is_premium),
          updated_at = now()`,
        [bot_slug, telegram_id, username || null, language_code || null, is_premium ?? null]
      );

      logger.debug(
        { bot_slug, telegram_id },
        '[CONTACTS] Contact upserted on interaction'
      );
    } catch (err) {
      logger.error(
        { err, bot_slug, telegram_id },
        '[CONTACTS] Failed to upsert contact on interaction'
      );
      throw err;
    }
  }

  /**
   * Mark contact as blocked
   */
  async markAsBlocked(bot_slug: string, telegram_id: number): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO telegram_contacts (
          bot_slug, 
          telegram_id, 
          chat_state, 
          first_seen_at,
          blocked_at
        )
        VALUES ($1, $2, 'blocked', now(), now())
        ON CONFLICT (bot_slug, telegram_id) 
        DO UPDATE SET
          chat_state = 'blocked'::chat_state_enum,
          blocked_at = now(),
          updated_at = now()`,
        [bot_slug, telegram_id]
      );

      logger.info(
        { bot_slug, telegram_id },
        '[CONTACTS] Contact marked as blocked'
      );
    } catch (err) {
      logger.error(
        { err, bot_slug, telegram_id },
        '[CONTACTS] Failed to mark contact as blocked'
      );
      throw err;
    }
  }

  /**
   * Mark contact as deactivated (user account deleted)
   */
  async markAsDeactivated(bot_slug: string, telegram_id: number): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO telegram_contacts (
          bot_slug, 
          telegram_id, 
          chat_state, 
          first_seen_at
        )
        VALUES ($1, $2, 'deactivated', now())
        ON CONFLICT (bot_slug, telegram_id) 
        DO UPDATE SET
          chat_state = 'deactivated'::chat_state_enum,
          updated_at = now()`,
        [bot_slug, telegram_id]
      );

      logger.info(
        { bot_slug, telegram_id },
        '[CONTACTS] Contact marked as deactivated'
      );
    } catch (err) {
      logger.error(
        { err, bot_slug, telegram_id },
        '[CONTACTS] Failed to mark contact as deactivated'
      );
      throw err;
    }
  }

  /**
   * Mark contact as active (unblocked or /start)
   */
  async markAsActive(params: UpsertContactParams): Promise<void> {
    const { bot_slug, telegram_id, username, language_code, is_premium } = params;

    try {
      await pool.query(
        `INSERT INTO telegram_contacts (
          bot_slug, 
          telegram_id, 
          chat_state, 
          first_seen_at,
          last_interaction_at,
          unblocked_at,
          username,
          language_code,
          is_premium
        )
        VALUES ($1, $2, 'active', now(), now(), now(), $3, $4, $5)
        ON CONFLICT (bot_slug, telegram_id) 
        DO UPDATE SET
          chat_state = 'active'::chat_state_enum,
          last_interaction_at = now(),
          unblocked_at = now(),
          username = COALESCE($3, telegram_contacts.username),
          language_code = COALESCE($4, telegram_contacts.language_code),
          is_premium = COALESCE($5, telegram_contacts.is_premium),
          updated_at = now()`,
        [bot_slug, telegram_id, username || null, language_code || null, is_premium ?? null]
      );

      logger.info(
        { bot_slug, telegram_id },
        '[CONTACTS] Contact marked as active'
      );
    } catch (err) {
      logger.error(
        { err, bot_slug, telegram_id },
        '[CONTACTS] Failed to mark contact as active'
      );
      throw err;
    }
  }

  /**
   * Get contact by bot_slug and telegram_id
   */
  async getContact(bot_slug: string, telegram_id: number): Promise<TelegramContact | null> {
    try {
      const result = await pool.query<TelegramContact>(
        `SELECT * FROM telegram_contacts 
         WHERE bot_slug = $1 AND telegram_id = $2`,
        [bot_slug, telegram_id]
      );

      return result.rows[0] || null;
    } catch (err) {
      logger.error(
        { err, bot_slug, telegram_id },
        '[CONTACTS] Failed to get contact'
      );
      throw err;
    }
  }

  /**
   * Get metrics for a bot within a time window
   */
  async getMetrics(bot_slug: string, days: number = 30): Promise<{
    active: number;
    blocked: number;
    unknown: number;
    total: number;
  }> {
    try {
      const result = await pool.query(
        `SELECT
          COUNT(*) FILTER (
            WHERE chat_state = 'active' 
            AND last_interaction_at >= now() - interval '1 day' * $2
          ) as active,
          COUNT(*) FILTER (
            WHERE chat_state IN ('blocked', 'deactivated')
          ) as blocked,
          COUNT(*) as total
         FROM telegram_contacts
         WHERE bot_slug = $1`,
        [bot_slug, days]
      );

      const row = result.rows[0];
      const active = parseInt(row.active || '0', 10);
      const blocked = parseInt(row.blocked || '0', 10);
      const total = parseInt(row.total || '0', 10);
      const unknown = total - active - blocked;

      return {
        active,
        blocked,
        unknown: Math.max(0, unknown),
        total,
      };
    } catch (err) {
      logger.error(
        { err, bot_slug, days },
        '[CONTACTS] Failed to get metrics'
      );
      throw err;
    }
  }
}

export const telegramContactsService = new TelegramContactsService();

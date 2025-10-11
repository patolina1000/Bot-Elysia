import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

export interface CreateOfferParams {
  bot_id: string;
  name: string;
  price_cents: number;
  currency?: string;
  metadata?: Record<string, any>;
}

export interface Offer {
  id: string;
  bot_id: string;
  name: string;
  price_cents: number;
  currency: string;
  metadata: Record<string, any> | null;
}

export class OfferService {
  async createOffer(params: CreateOfferParams): Promise<string> {
    const result = await pool.query(
      `INSERT INTO offers (bot_id, name, price_cents, currency, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        params.bot_id,
        params.name,
        params.price_cents,
        params.currency || 'BRL',
        params.metadata ? JSON.stringify(params.metadata) : null,
      ]
    );

    logger.info({ offerId: result.rows[0].id, botId: params.bot_id }, 'Offer created');

    return result.rows[0].id;
  }

  async getOffersByBotId(botId: string): Promise<Offer[]> {
    const result = await pool.query(
      `SELECT id, bot_id, name, price_cents, currency, metadata
       FROM offers
       WHERE bot_id = $1
       ORDER BY created_at DESC`,
      [botId]
    );

    return result.rows;
  }

  async getOfferById(offerId: string): Promise<Offer | null> {
    const result = await pool.query(
      `SELECT id, bot_id, name, price_cents, currency, metadata
       FROM offers
       WHERE id = $1`,
      [offerId]
    );

    return result.rows[0] || null;
  }
}

export const offerService = new OfferService();

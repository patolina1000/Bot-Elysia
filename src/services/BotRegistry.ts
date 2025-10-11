import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { getEncryptionKey } from '../utils/crypto.js';

export interface BotConfig {
  id: string;
  slug: string;
  name: string;
  token: string;
  webhook_secret: string;
  enabled: boolean;
  features: Record<string, boolean>;
}

export class BotRegistry {
  private cache = new Map<string, BotConfig>();

  async createBot(params: {
    slug: string;
    name: string;
    token: string;
    webhook_secret: string;
    features?: Record<string, boolean>;
  }): Promise<{ id: string; slug: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert bot with encrypted token
      const botResult = await client.query(
        `INSERT INTO bots (slug, name, token_encrypted, webhook_secret)
         VALUES ($1, $2, pgp_sym_encrypt($3::text, $4), $5)
         RETURNING id, slug`,
        [params.slug, params.name, params.token, getEncryptionKey(), params.webhook_secret]
      );

      const botId = botResult.rows[0].id;

      // Insert features
      if (params.features) {
        for (const [key, enabled] of Object.entries(params.features)) {
          await client.query(
            `INSERT INTO bot_features (bot_id, key, enabled) VALUES ($1, $2, $3)`,
            [botId, key, enabled]
          );
        }
      }

      await client.query('COMMIT');

      logger.info({ botId, slug: params.slug }, 'Bot created');

      return { id: botId, slug: params.slug };
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, slug: params.slug }, 'Failed to create bot');
      throw err;
    } finally {
      client.release();
    }
  }

  async getBotBySlug(slug: string): Promise<BotConfig | null> {
    // Check cache first
    if (this.cache.has(slug)) {
      return this.cache.get(slug)!;
    }

    try {
      const result = await pool.query(
        `SELECT 
          b.id, 
          b.slug, 
          b.name, 
          pgp_sym_decrypt(b.token_encrypted, $2)::text as token, 
          b.webhook_secret, 
          b.enabled,
          COALESCE(
            json_object_agg(bf.key, bf.enabled) FILTER (WHERE bf.key IS NOT NULL),
            '{}'::json
          ) as features
         FROM bots b
         LEFT JOIN bot_features bf ON bf.bot_id = b.id
         WHERE b.slug = $1
         GROUP BY b.id, b.slug, b.name, b.token_encrypted, b.webhook_secret, b.enabled`,
        [slug, getEncryptionKey()]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const bot: BotConfig = {
        id: result.rows[0].id,
        slug: result.rows[0].slug,
        name: result.rows[0].name,
        token: result.rows[0].token,
        webhook_secret: result.rows[0].webhook_secret,
        enabled: result.rows[0].enabled,
        features: result.rows[0].features || {},
      };

      // Cache the result
      this.cache.set(slug, bot);

      return bot;
    } catch (err) {
      logger.error({ err, slug }, 'Failed to get bot by slug');
      return null;
    }
  }

  async getBotById(botId: string): Promise<BotConfig | null> {
    try {
      const result = await pool.query(
        `SELECT 
          b.id, 
          b.slug, 
          b.name, 
          pgp_sym_decrypt(b.token_encrypted, $2)::text as token, 
          b.webhook_secret, 
          b.enabled,
          COALESCE(
            json_object_agg(bf.key, bf.enabled) FILTER (WHERE bf.key IS NOT NULL),
            '{}'::json
          ) as features
         FROM bots b
         LEFT JOIN bot_features bf ON bf.bot_id = b.id
         WHERE b.id = $1
         GROUP BY b.id, b.slug, b.name, b.token_encrypted, b.webhook_secret, b.enabled`,
        [botId, getEncryptionKey()]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return {
        id: result.rows[0].id,
        slug: result.rows[0].slug,
        name: result.rows[0].name,
        token: result.rows[0].token,
        webhook_secret: result.rows[0].webhook_secret,
        enabled: result.rows[0].enabled,
        features: result.rows[0].features || {},
      };
    } catch (err) {
      logger.error({ err, botId }, 'Failed to get bot by id');
      return null;
    }
  }

  invalidateCache(slug: string) {
    this.cache.delete(slug);
  }

  clearCache() {
    this.cache.clear();
  }
}

export const botRegistry = new BotRegistry();

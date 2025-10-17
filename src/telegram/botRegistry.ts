import type { Bot } from 'grammy';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import type { MyContext } from './grammYContext.js';
import { getExistingBotInstanceBySlug, getOrCreateBotBySlug } from './botFactory.js';

function normalizeSlug(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

class TelegramBotRegistry {
  async loadAllEnabledBots(): Promise<void> {
    const { rows } = await pool.query<{ slug: string | null }>(
      `SELECT slug FROM bots WHERE enabled = true`
    );

    await Promise.all(
      rows
        .map((row) => normalizeSlug(row.slug))
        .filter((slug): slug is string => Boolean(slug))
        .map(async (slug) => {
          try {
            await this.ensure(slug);
            logger.info({ bot_slug: slug }, '[BOT][REGISTRY] bot inicializado');
          } catch (err) {
            logger.error({ bot_slug: slug, err }, '[BOT][REGISTRY] falha ao inicializar bot');
          }
        })
    );
  }

  async ensure(slug: string): Promise<Bot<MyContext>> {
    const existing = this.get(slug);
    if (existing) {
      return existing;
    }

    const bot = await getOrCreateBotBySlug(slug);
    return bot;
  }

  get(slug: string): Bot<MyContext> | undefined {
    return getExistingBotInstanceBySlug(slug);
  }
}

export const botRegistry = new TelegramBotRegistry();

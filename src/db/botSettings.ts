import { pool } from './pool.js';

export interface BotSettings {
  bot_slug: string;
  pix_image_url: string | null;
}

export async function getSettings(botSlug: string): Promise<BotSettings> {
  const result = await pool.query(
    'select bot_slug, pix_image_url from bot_settings where bot_slug = $1 limit 1',
    [botSlug]
  );

  if (result.rows[0]) {
    return {
      bot_slug: String(result.rows[0].bot_slug),
      pix_image_url: result.rows[0].pix_image_url ? String(result.rows[0].pix_image_url) : null,
    };
  }

  return { bot_slug: botSlug, pix_image_url: null };
}

export async function saveSettings(
  botSlug: string,
  settings: { pix_image_url?: string | null } = {}
): Promise<BotSettings> {
  const pixImageUrl = settings.pix_image_url ?? null;

  const result = await pool.query(
    `insert into bot_settings (bot_slug, pix_image_url)
     values ($1, $2)
     on conflict (bot_slug) do update
       set pix_image_url = excluded.pix_image_url,
           updated_at = now()
     returning bot_slug, pix_image_url`,
    [botSlug, pixImageUrl]
  );

  return {
    bot_slug: String(result.rows[0].bot_slug),
    pix_image_url: result.rows[0].pix_image_url ? String(result.rows[0].pix_image_url) : null,
  };
}

import { pool } from './pool.js';

export interface BotSettings {
  bot_slug: string;
  pix_image_url: string | null;
  offers_text: string | null;
  public_base_url: string | null;
}

export async function getSettings(botSlug: string): Promise<BotSettings> {
  const result = await pool.query(
    'select bot_slug, pix_image_url, offers_text, public_base_url from bot_settings where bot_slug = $1 limit 1',
    [botSlug]
  );

  if (result.rows[0]) {
    return {
      bot_slug: String(result.rows[0].bot_slug),
      pix_image_url: result.rows[0].pix_image_url ? String(result.rows[0].pix_image_url) : null,
      offers_text: result.rows[0].offers_text ? String(result.rows[0].offers_text) : null,
      public_base_url: result.rows[0].public_base_url ? String(result.rows[0].public_base_url) : null,
    };
  }

  return { bot_slug: botSlug, pix_image_url: null, offers_text: null, public_base_url: null };
}

export async function saveSettings(
  botSlug: string,
  settings: { pix_image_url?: string | null; offers_text?: string | null; public_base_url?: string | null } = {}
): Promise<BotSettings> {
  const pixImageUrl = settings.pix_image_url ?? null;
  const offersText = settings.offers_text ?? null;
  const publicBaseUrl = settings.public_base_url ?? null;

  const result = await pool.query(
    `insert into bot_settings (bot_slug, pix_image_url, offers_text, public_base_url)
     values ($1, $2, $3, $4)
     on conflict (bot_slug) do update
       set pix_image_url = excluded.pix_image_url,
           offers_text = excluded.offers_text,
           public_base_url = excluded.public_base_url,
           updated_at = now()
     returning bot_slug, pix_image_url, offers_text, public_base_url`,
    [botSlug, pixImageUrl, offersText, publicBaseUrl]
  );

  return {
    bot_slug: String(result.rows[0].bot_slug),
    pix_image_url: result.rows[0].pix_image_url ? String(result.rows[0].pix_image_url) : null,
    offers_text: result.rows[0].offers_text ? String(result.rows[0].offers_text) : null,
    public_base_url: result.rows[0].public_base_url ? String(result.rows[0].public_base_url) : null,
  };
}

export async function getBotSettings(botSlug: string): Promise<BotSettings> {
  return getSettings(botSlug);
}

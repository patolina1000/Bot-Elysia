import { pool } from './pool.js';

export interface BotSettings {
  bot_slug: string;
  pix_image_url: string | null;
  offers_text: string;
  pix_downsell_text: string;
}

export async function getSettings(botSlug: string): Promise<BotSettings> {
  const result = await pool.query(`select * from bot_settings where bot_slug = $1 limit 1`, [botSlug]);

  const row: any = result.rows?.[0] ?? {};

  return {
    bot_slug: String(row.bot_slug ?? botSlug),
    pix_image_url: row.pix_image_url ? String(row.pix_image_url) : null,
    offers_text: String(row.offers_text ?? ''),
    pix_downsell_text: String(row.pix_downsell_text ?? ''),
  };
}

export async function saveSettings(
  botSlug: string,
  settings: { pix_image_url?: string | null; offers_text?: string | null; pix_downsell_text?: string | null } = {}
): Promise<BotSettings> {
  const pixImageUrl = settings.pix_image_url ?? null;
  const offersText = settings.offers_text ?? null;
  const pixDownsellText = settings.pix_downsell_text ?? null;

  const result = await pool.query(
    `insert into bot_settings (bot_slug, pix_image_url, offers_text, pix_downsell_text)
     values ($1, $2, $3, $4)
     on conflict (bot_slug) do update
       set pix_image_url = excluded.pix_image_url,
           offers_text = excluded.offers_text,
           pix_downsell_text = excluded.pix_downsell_text,
           updated_at = now()
     returning bot_slug, pix_image_url, offers_text, pix_downsell_text`,
    [botSlug, pixImageUrl, offersText, pixDownsellText]
  );

  return {
    bot_slug: String(result.rows[0].bot_slug),
    pix_image_url: result.rows[0].pix_image_url ? String(result.rows[0].pix_image_url) : null,
    offers_text: String(result.rows[0].offers_text ?? ''),
    pix_downsell_text: String(result.rows[0].pix_downsell_text ?? ''),
  };
}

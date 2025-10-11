import { pool } from '../db/pool.js';
import { getEncryptionKey } from '../utils/crypto.js';

export interface AdminBotMinimal {
  id: string;
  slug: string | null;
  name: string | null;
  created_at: string;
  token?: string | null;
  warmup_chat_id?: string | null;
}

export interface StartTemplateMedia {
  type: 'photo' | 'video' | 'audio';
  url: string;
}

export interface StartTemplateResponse {
  parse_mode: string;
  text: string;
  medias: StartTemplateMedia[];
  prices?: unknown;
}

export interface AdminBotFeatures {
  id: string;
  slug: string;
  features: Record<string, boolean>;
}

async function listBotsMinimal(): Promise<AdminBotMinimal[]> {
  const result = await pool.query(
    `SELECT
       b.id,
       b.slug,
       b.name,
       b.created_at,
       pgp_sym_decrypt(b.token_encrypted, $1)::text AS token,
       settings.warmup_chat_id
     FROM bots b
     LEFT JOIN public.tg_bot_settings settings ON settings.bot_slug = b.slug
     ORDER BY b.created_at ASC`,
    [getEncryptionKey()]
  );

  return result.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    token: row.token,
    warmup_chat_id: row.warmup_chat_id ? String(row.warmup_chat_id) : null,
  }));
}

async function getStartTemplate(botId: string): Promise<StartTemplateResponse | null> {
  const [templateResult, mediaResult] = await Promise.all([
    pool.query(
      `SELECT parse_mode, text FROM templates_start WHERE bot_id = $1`,
      [botId]
    ),
    pool.query(
      `SELECT kind, COALESCE(source_url, file_id) AS source
       FROM media_assets
       WHERE bot_id = $1
       ORDER BY created_at ASC`,
      [botId]
    ),
  ]);

  const templateRow = templateResult.rows[0];
  const medias: StartTemplateMedia[] = mediaResult.rows
    .filter((row) => Boolean(row.source))
    .map((row) => ({
      type: row.kind as StartTemplateMedia['type'],
      url: row.source as string,
    }));

  if (!templateRow) {
    return null;
  }

  return {
    parse_mode: templateRow.parse_mode,
    text: templateRow.text,
    medias,
  };
}

async function getBotFeaturesBySlug(slug: string): Promise<AdminBotFeatures | null> {
  const result = await pool.query(
    `SELECT b.id, b.slug,
            COALESCE(
              (SELECT json_object_agg(bf.key, bf.enabled)
               FROM bot_features bf
               WHERE bf.bot_id = b.id),
              '{}'::json
            ) AS features
       FROM bots b
       WHERE b.slug = $1
       LIMIT 1`,
    [slug]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const features =
    typeof row.features === 'object' && row.features !== null ? (row.features as Record<string, boolean>) : {};

  return {
    id: row.id,
    slug: row.slug,
    features,
  };
}

async function getBotIdBySlug(slug: string): Promise<string | null> {
  const result = await pool.query(`SELECT id FROM bots WHERE slug = $1 LIMIT 1`, [slug]);
  const row = result.rows[0];
  return row ? (row.id as string) : null;
}

async function upsertWarmupChatId(slug: string, warmupChatId: string): Promise<void> {
  await pool.query(
    `INSERT INTO public.tg_bot_settings (bot_slug, warmup_chat_id)
     VALUES ($1, $2)
     ON CONFLICT (bot_slug) DO UPDATE SET warmup_chat_id = EXCLUDED.warmup_chat_id`,
    [slug, warmupChatId]
  );
}

export const adminBotsDb = {
  listBotsMinimal,
  getStartTemplate,
  getBotFeaturesBySlug,
  getBotIdBySlug,
  upsertWarmupChatId,
};

export type AdminBotsDb = typeof adminBotsDb;

import { pool } from './pool.js';

export type DownsellTrigger = 'after_start' | 'after_pix';

export interface BotDownsell {
  id: number;
  bot_slug: string;
  price_cents: number;
  copy: string;
  media_url: string | null;
  media_type: string | null;
  trigger: DownsellTrigger;
  delay_minutes: number;
  sort_order: number | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: any): BotDownsell {
  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    price_cents: Number(row.price_cents ?? 0),
    copy: String(row.copy ?? ''),
    media_url: row.media_url ? String(row.media_url) : null,
    media_type: row.media_type ? String(row.media_type) : null,
    trigger: (row.trigger ?? 'after_start') as DownsellTrigger,
    delay_minutes: Number(row.delay_minutes ?? 0),
    sort_order: row.sort_order !== null && row.sort_order !== undefined ? Number(row.sort_order) : null,
    active: Boolean(row.active ?? true),
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

export async function listActiveDownsellsByMoment(
  bot_slug: string,
  trigger: DownsellTrigger
): Promise<BotDownsell[]> {
  const { rows } = await pool.query(
    `SELECT id, bot_slug, price_cents, copy, media_url, media_type, trigger, delay_minutes, sort_order, active, created_at, updated_at
       FROM bot_downsells
      WHERE bot_slug = $1
        AND trigger = $2
        AND (active IS NULL OR active = true)
      ORDER BY sort_order NULLS LAST, id ASC`,
    [bot_slug, trigger]
  );

  return rows
    .map(mapRow)
    .filter((downsell) => Number.isFinite(downsell.price_cents) && downsell.price_cents > 0);
}

export async function getDownsellById(id: number): Promise<BotDownsell | null> {
  const { rows } = await pool.query(
    `SELECT id, bot_slug, price_cents, copy, media_url, media_type, trigger, delay_minutes, sort_order, active, created_at, updated_at
       FROM bot_downsells
      WHERE id = $1
      LIMIT 1`,
    [id]
  );

  const row = rows[0];
  return row ? mapRow(row) : null;
}

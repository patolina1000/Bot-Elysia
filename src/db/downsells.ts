import { pool } from './pool.js';

export type DownsellTrigger = 'after_start' | 'after_pix';
export type MediaType = 'photo' | 'video' | 'audio';
export type QueueStatus = 'scheduled' | 'sent' | 'skipped' | 'canceled' | 'error';

export interface Downsell {
  id: number;
  bot_slug: string;
  trigger_kind: DownsellTrigger;
  delay_minutes: number;
  title: string;
  price_cents: number;
  message_text: string | null;
  media1_url: string | null;
  media1_type: MediaType | null;
  media2_url: string | null;
  media2_type: MediaType | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpsertDownsellInput {
  id?: number;
  bot_slug: string;
  trigger_kind: DownsellTrigger;
  delay_minutes: number; // 5..60
  title: string;
  price_cents: number;   // >= 50
  message_text?: string | null;
  media1_url?: string | null;
  media1_type?: MediaType | null;
  media2_url?: string | null;
  media2_type?: MediaType | null;
  is_active?: boolean;
}

function mapRow(r: any): Downsell {
  return {
    id: Number(r.id),
    bot_slug: r.bot_slug,
    trigger_kind: r.trigger_kind,
    delay_minutes: Number(r.delay_minutes),
    title: r.title,
    price_cents: Number(r.price_cents),
    message_text: r.message_text ?? null,
    media1_url: r.media1_url ?? null,
    media1_type: r.media1_type ?? null,
    media2_url: r.media2_url ?? null,
    media2_type: r.media2_type ?? null,
    is_active: !!r.is_active,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function listDownsellsByBot(botSlug: string): Promise<Downsell[]> {
  const res = await pool.query(
    `SELECT * FROM downsells WHERE bot_slug = $1 ORDER BY created_at DESC`,
    [botSlug]
  );
  return res.rows.map(mapRow);
}

export async function getDownsell(id: number, botSlug: string): Promise<Downsell | null> {
  const res = await pool.query(
    `SELECT * FROM downsells WHERE id = $1 AND bot_slug = $2`,
    [id, botSlug]
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function upsertDownsell(input: UpsertDownsellInput): Promise<Downsell> {
  const active = input.is_active ?? true;
  if (input.id) {
    const res = await pool.query(
      `UPDATE downsells
         SET trigger_kind = $1,
             delay_minutes = $2,
             title = $3,
             price_cents = $4,
             message_text = $5,
             media1_url = $6, media1_type = $7,
             media2_url = $8, media2_type = $9,
             is_active = $10
       WHERE id = $11 AND bot_slug = $12
       RETURNING *`,
      [
        input.trigger_kind,
        input.delay_minutes,
        input.title,
        input.price_cents,
        input.message_text ?? null,
        input.media1_url ?? null,
        input.media1_type ?? null,
        input.media2_url ?? null,
        input.media2_type ?? null,
        active,
        input.id,
        input.bot_slug,
      ]
    );
    if (!res.rows[0]) throw new Error('Downsell not found for update');
    return mapRow(res.rows[0]);
  } else {
    const res = await pool.query(
      `INSERT INTO downsells
        (bot_slug, trigger_kind, delay_minutes, title, price_cents, message_text,
         media1_url, media1_type, media2_url, media2_type, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        input.bot_slug,
        input.trigger_kind,
        input.delay_minutes,
        input.title,
        input.price_cents,
        input.message_text ?? null,
        input.media1_url ?? null,
        input.media1_type ?? null,
        input.media2_url ?? null,
        input.media2_type ?? null,
        active,
      ]
    );
    return mapRow(res.rows[0]);
  }
}

export async function deleteDownsell(id: number, botSlug: string): Promise<boolean> {
  const res = await pool.query(`DELETE FROM downsells WHERE id = $1 AND bot_slug = $2`, [id, botSlug]);
  return (res.rowCount ?? 0) > 0;
}

// --------- Fila (queue) ----------
export interface QueueItem {
  id: number;
  downsell_id: number;
  bot_slug: string;
  telegram_id: number;
  scheduled_at: string;
  sent_at: string | null;
  status: QueueStatus;
  error: string | null;
}

function mapQueueRow(r: any): QueueItem {
  return {
    id: Number(r.id),
    downsell_id: Number(r.downsell_id),
    bot_slug: r.bot_slug,
    telegram_id: Number(r.telegram_id),
    scheduled_at: r.scheduled_at instanceof Date ? r.scheduled_at.toISOString() : String(r.scheduled_at),
    sent_at: r.sent_at ? (r.sent_at instanceof Date ? r.sent_at.toISOString() : String(r.sent_at)) : null,
    status: r.status,
    error: r.error ?? null,
  };
}

export async function scheduleDownsellForUser(params: {
  downsell_id: number;
  bot_slug: string;
  telegram_id: number;
  scheduled_at: Date;
}): Promise<QueueItem> {
  const res = await pool.query(
    `INSERT INTO downsells_queue (downsell_id, bot_slug, telegram_id, scheduled_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (downsell_id, telegram_id) DO UPDATE SET
       scheduled_at = EXCLUDED.scheduled_at,
       status = 'scheduled',
       updated_at = now()
     RETURNING *`,
    [params.downsell_id, params.bot_slug, params.telegram_id, params.scheduled_at]
  );
  return mapQueueRow(res.rows[0]);
}

export async function findPendingToSend(limit = 50): Promise<QueueItem[]> {
  const res = await pool.query(
    `SELECT * FROM downsells_queue
      WHERE status = 'scheduled' AND scheduled_at <= now()
      ORDER BY scheduled_at ASC
      LIMIT $1`,
    [limit]
  );
  return res.rows.map(mapQueueRow);
}

export async function markQueueSent(id: number): Promise<void> {
  await pool.query(
    `UPDATE downsells_queue SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`,
    [id]
  );
}

export async function markQueueError(id: number, error: string): Promise<void> {
  await pool.query(
    `UPDATE downsells_queue SET status = 'error', error = $2, updated_at = now() WHERE id = $1`,
    [id, error.slice(0, 500)]
  );
}

export async function cancelPendingForUser(botSlug: string, telegramId: number): Promise<number> {
  const res = await pool.query(
    `UPDATE downsells_queue
       SET status = 'canceled', updated_at = now()
     WHERE bot_slug = $1 AND telegram_id = $2 AND status = 'scheduled'`,
    [botSlug, telegramId]
  );
  return res.rowCount ?? 0;
}

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
  window_enabled: boolean;
  window_start_hour: number | null;
  window_end_hour: number | null;
  window_tz: string | null;
  daily_cap_per_user: number;
  ab_enabled: boolean;
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
  window_enabled?: boolean;
  window_start_hour?: number | null;
  window_end_hour?: number | null;
  window_tz?: string | null;
  daily_cap_per_user?: number;
  ab_enabled?: boolean;
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
    window_enabled: !!r.window_enabled,
    window_start_hour: r.window_start_hour !== null ? Number(r.window_start_hour) : null,
    window_end_hour: r.window_end_hour !== null ? Number(r.window_end_hour) : null,
    window_tz: r.window_tz ?? null,
    daily_cap_per_user: Number(r.daily_cap_per_user ?? 0),
    ab_enabled: !!r.ab_enabled,
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
             window_enabled = $10,
             window_start_hour = $11,
             window_end_hour = $12,
             window_tz = $13,
             daily_cap_per_user = $14,
             ab_enabled = $15,
             is_active = $16
       WHERE id = $17 AND bot_slug = $18
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
        input.window_enabled ?? false,
        input.window_start_hour ?? null,
        input.window_end_hour ?? null,
        input.window_tz ?? null,
        input.daily_cap_per_user ?? 0,
        input.ab_enabled ?? false,
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
         media1_url, media1_type, media2_url, media2_type,
         window_enabled, window_start_hour, window_end_hour, window_tz,
         daily_cap_per_user, ab_enabled, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
        input.window_enabled ?? false,
        input.window_start_hour ?? null,
        input.window_end_hour ?? null,
        input.window_tz ?? null,
        input.daily_cap_per_user ?? 0,
        input.ab_enabled ?? false,
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

// === MÉTRICAS (mini dashboard) ===
export interface DownsellStats {
  scheduled: number;
  sent: number;
  canceled: number;
  error: number;
  pix: number;
  purchased: number;
  last_seen?: string | null;
}

export async function getDownsellsStats(botSlug: string): Promise<Record<string, DownsellStats>> {
  const res = await pool.query(
    `
      SELECT bot_slug, scheduled, sent, canceled, error, pix, purchased, last_seen
      FROM public.admin_downsell_metrics
      WHERE bot_slug = $1
    `,
    [botSlug]
  );

  if (res.rows.length === 0) {
    return {};
  }

  const stats: Record<string, DownsellStats> = {};
  for (const row of res.rows) {
    stats['__aggregate__'] = {
      scheduled: Number(row.scheduled ?? 0),
      sent: Number(row.sent ?? 0),
      canceled: Number(row.canceled ?? 0),
      error: Number(row.error ?? 0),
      pix: Number(row.pix ?? 0),
      purchased: Number(row.purchased ?? 0),
      last_seen:
        row.last_seen instanceof Date
          ? row.last_seen.toISOString()
          : row.last_seen
          ? String(row.last_seen)
          : null,
    };
  }

  return stats;
}

// ===== VARIANTS (A/B) =====
export interface DownsellVariant {
  id: number;
  downsell_id: number;
  key: 'A' | 'B';
  weight: number; // 0..100
  title: string | null;
  price_cents: number | null;
  message_text: string | null;
  media1_url: string | null;
  media1_type: MediaType | null;
  media2_url: string | null;
  media2_type: MediaType | null;
}

export async function listVariants(downsellId: number): Promise<DownsellVariant[]> {
  const res = await pool.query(`SELECT * FROM downsells_variants WHERE downsell_id = $1 ORDER BY key ASC`, [downsellId]);
  return res.rows.map(r => ({
    id: Number(r.id),
    downsell_id: Number(r.downsell_id),
    key: r.key,
    weight: Number(r.weight),
    title: r.title ?? null,
    price_cents: r.price_cents !== null ? Number(r.price_cents) : null,
    message_text: r.message_text ?? null,
    media1_url: r.media1_url ?? null,
    media1_type: r.media1_type ?? null,
    media2_url: r.media2_url ?? null,
    media2_type: r.media2_type ?? null,
  }));
}

export async function upsertVariant(input: Omit<DownsellVariant, 'id'> & { id?: number }): Promise<DownsellVariant> {
  if (input.id) {
    const res = await pool.query(
      `UPDATE downsells_variants
         SET weight=$1, title=$2, price_cents=$3, message_text=$4,
             media1_url=$5, media1_type=$6, media2_url=$7, media2_type=$8
       WHERE id=$9 AND downsell_id=$10 AND key=$11
       RETURNING *`,
      [input.weight, input.title, input.price_cents, input.message_text,
       input.media1_url, input.media1_type, input.media2_url, input.media2_type,
       input.id, input.downsell_id, input.key]
    );
    return (await listVariants(input.downsell_id)).find(v => v.id === Number(res.rows[0].id))!;
  } else {
    const res = await pool.query(
      `INSERT INTO downsells_variants (downsell_id, key, weight, title, price_cents, message_text,
                                       media1_url, media1_type, media2_url, media2_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (downsell_id, key) DO UPDATE SET
         weight=EXCLUDED.weight, title=EXCLUDED.title, price_cents=EXCLUDED.price_cents, message_text=EXCLUDED.message_text,
         media1_url=EXCLUDED.media1_url, media1_type=EXCLUDED.media1_type, media2_url=EXCLUDED.media2_url, media2_type=EXCLUDED.media2_type
       RETURNING *`,
      [input.downsell_id, input.key, input.weight, input.title, input.price_cents, input.message_text,
       input.media1_url, input.media1_type, input.media2_url, input.media2_type]
    );
    return (await listVariants(input.downsell_id)).find(v => v.id === Number(res.rows[0].id))!;
  }
}

export async function deleteVariant(downsellId: number, key: 'A'|'B'): Promise<boolean> {
  const res = await pool.query(`DELETE FROM downsells_variants WHERE downsell_id=$1 AND key=$2`, [downsellId, key]);
  return (res.rowCount ?? 0) > 0;
}

// ===== DAILY CAP (global por bot/usuário) =====
export async function countSentTodayForUser(botSlug: string, telegramId: number, timezone: string): Promise<number> {
  // janela do dia no timezone indicado
  const now = new Date();
  // calcula YYYY-MM-DD "local"
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = fmt.format(now); // 'YYYY-MM-DD'
  const start = new Date(`${parts}T00:00:00.000Z`);
  const end   = new Date(`${parts}T23:59:59.999Z`);
  const res = await pool.query(
    `SELECT COUNT(*) AS c FROM downsells_queue
     WHERE bot_slug=$1 AND telegram_id=$2 AND status='sent'
       AND sent_at >= $3 AND sent_at <= $4`,
    [botSlug, telegramId, start, end]
  );
  return Number(res.rows[0]?.c ?? 0);
}

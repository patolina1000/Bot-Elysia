import { pool } from './pool.js';

export type ShotAudience = 'started' | 'pix';
export type ShotSendMode = 'now' | 'scheduled';
export type ShotStatus = 'draft' | 'queued' | 'scheduled' | 'sent' | 'canceled' | 'error';

export interface BotShot {
  id: number;
  bot_slug: string;
  audience: ShotAudience;
  send_mode: ShotSendMode;
  scheduled_at: Date | null;
  timezone: string;
  button_text: string;
  price_cents: number | null;
  extra_plans: { label: string; price_cents: number }[];
  intro_text: string | null;
  copy: string | null;
  media_url: string | null;
  media_type: string | null;
  active: boolean;
  status: ShotStatus;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: any): BotShot {
  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    audience: String(row.audience) as ShotAudience,
    send_mode: String(row.send_mode) as ShotSendMode,
    scheduled_at: row.scheduled_at ? (row.scheduled_at instanceof Date ? row.scheduled_at : new Date(row.scheduled_at)) : null,
    timezone: String(row.timezone ?? 'America/Sao_Paulo'),
    button_text: String(row.button_text ?? ''),
    price_cents: row.price_cents === null || row.price_cents === undefined ? null : Number(row.price_cents),
    extra_plans: Array.isArray(row.extra_plans)
      ? row.extra_plans.map((plan: any) => {
          const label = typeof plan?.label === 'string' ? plan.label : String(plan?.label ?? '');
          const rawCents = Number(plan?.price_cents);
          const centsFromNumber = Number.isFinite(rawCents) ? Math.round(rawCents) : null;
          const rawPrice = Number(plan?.price);
          const centsFromPrice = Number.isFinite(rawPrice) ? Math.round(rawPrice * 100) : null;
          const price_cents = centsFromNumber ?? centsFromPrice ?? 0;
          return { label, price_cents };
        })
      : [],
    intro_text: row.intro_text ? String(row.intro_text) : null,
    copy: row.copy ? String(row.copy) : null,
    media_url: row.media_url ? String(row.media_url) : null,
    media_type: row.media_type ? String(row.media_type) : null,
    active: Boolean(row.active ?? true),
    status: String(row.status ?? 'draft') as ShotStatus,
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

export interface CreateShotParams {
  bot_slug: string;
  audience: ShotAudience;
  send_mode: ShotSendMode;
  scheduled_at?: Date | null;
  timezone?: string;
  button_text: string;
  price_cents?: number | null;
  extra_plans?: { label: string; price_cents: number }[];
  intro_text?: string | null;
  copy?: string | null;
  media_url?: string | null;
  media_type?: string | null;
}

export async function createShot(params: CreateShotParams): Promise<BotShot> {
  const extraPlans = params.extra_plans ?? [];
  
  // Validate extra_plans max 8 items
  if (extraPlans.length > 8) {
    throw new Error('extra_plans cannot have more than 8 items');
  }

  const { rows } = await pool.query(
    `INSERT INTO bot_shots (
      bot_slug, audience, send_mode, scheduled_at, timezone,
      button_text, price_cents, extra_plans, intro_text, copy,
      media_url, media_type, active, status, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, true, 'draft', NOW(), NOW())
    RETURNING *`,
    [
      params.bot_slug,
      params.audience,
      params.send_mode,
      params.scheduled_at ?? null,
      params.timezone ?? 'America/Sao_Paulo',
      params.button_text,
      params.price_cents ?? null,
      JSON.stringify(extraPlans),
      params.intro_text ?? null,
      params.copy ?? null,
      params.media_url ?? null,
      params.media_type ?? null,
    ]
  );

  return mapRow(rows[0]);
}

export async function updateShotStatus(id: number, status: ShotStatus): Promise<BotShot | null> {
  const { rows } = await pool.query(
    `UPDATE bot_shots
        SET status = $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, status]
  );

  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getShotById(id: number): Promise<BotShot | null> {
  const { rows } = await pool.query(
    `SELECT *,
            COALESCE(extra_plans, '[]'::jsonb) AS extra_plans
       FROM bot_shots
      WHERE id = $1
      LIMIT 1`,
    [id]
  );

  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listShots(bot_slug: string): Promise<BotShot[]> {
  const { rows } = await pool.query(
    `SELECT *,
            COALESCE(extra_plans, '[]'::jsonb) AS extra_plans
       FROM bot_shots
      WHERE bot_slug = $1
      ORDER BY created_at DESC`,
    [bot_slug]
  );

  return rows.map(mapRow);
}

export async function deleteShot(id: number): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM bot_shots WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

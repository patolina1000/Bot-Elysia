import { pool } from './pool.js';

export type DownsellTrigger = 'after_start' | 'after_pix';

export interface BotDownsell {
  id: number;
  bot_slug: string;
  price_cents: number | null;
  copy: string;
  button_intro_text?: string | null;
  media_url: string | null;
  media_type: string | null;
  trigger: DownsellTrigger;
  delay_minutes: number;
  sort_order: number | null;
  active: boolean;
  plan_id: number | null;
  plan_label: string | null;
  plan_price_cents?: number | null;
  plan_name?: string | null;
  extra_plans: { label: string; price_cents: number }[];
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: any): BotDownsell {
  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    price_cents:
      row.price_cents === null || row.price_cents === undefined ? null : Number(row.price_cents),
    copy: String(row.copy ?? ''),
    button_intro_text: row.button_intro_text ? String(row.button_intro_text) : null,
    media_url: row.media_url ? String(row.media_url) : null,
    media_type: row.media_type ? String(row.media_type) : null,
    trigger: (row.trigger ?? 'after_start') as DownsellTrigger,
    delay_minutes: Number(row.delay_minutes ?? 0),
    sort_order: row.sort_order !== null && row.sort_order !== undefined ? Number(row.sort_order) : null,
    active: Boolean(row.active ?? true),
    plan_id: row.plan_id === null || row.plan_id === undefined ? null : Number(row.plan_id),
    plan_label: row.plan_label ? String(row.plan_label) : null,
    plan_price_cents:
      row.plan_price_cents === null || row.plan_price_cents === undefined
        ? null
        : Number(row.plan_price_cents),
    plan_name: row.plan_name ? String(row.plan_name) : null,
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
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

export async function listActiveDownsellsByMoment(
  bot_slug: string,
  trigger: DownsellTrigger
): Promise<BotDownsell[]> {
  const { rows } = await pool.query(
    `SELECT d.id,
            d.bot_slug,
            d.price_cents,
            d.copy,
            d.button_intro_text,
            d.media_url,
            d.media_type,
            d.trigger,
            d.delay_minutes,
            d.sort_order,
            d.active,
            d.plan_label,
            d.plan_id,
            COALESCE(d.extra_plans, '[]'::jsonb) AS extra_plans,
            d.created_at,
            d.updated_at
       FROM bot_downsells d
      WHERE d.bot_slug = $1
        AND d.trigger = $2
        AND (d.active IS NULL OR d.active = true)
      ORDER BY d.sort_order NULLS LAST, d.id DESC`,
    [bot_slug, trigger]
  );

  return rows
    .map(mapRow)
    .filter((downsell) => {
      const hasPrice =
        typeof downsell.price_cents === 'number' &&
        Number.isFinite(downsell.price_cents) &&
        downsell.price_cents > 0;
      const hasPlan = downsell.plan_id !== null;
      const hasPlanPrice =
        typeof downsell.plan_price_cents === 'number' &&
        Number.isFinite(downsell.plan_price_cents) &&
        downsell.plan_price_cents > 0;
      const hasExtraPlan = Array.isArray(downsell.extra_plans)
        ? downsell.extra_plans.some(
            (plan) =>
              typeof plan?.price_cents === 'number' &&
              Number.isFinite(plan.price_cents) &&
              plan.price_cents > 0 &&
              typeof plan.label === 'string' &&
              plan.label.trim().length > 0
          )
        : false;
      return hasPrice || hasPlan || hasPlanPrice || hasExtraPlan;
    });
}

export async function getDownsellById(id: number): Promise<BotDownsell | null> {
  const { rows } = await pool.query(
    `SELECT d.id,
            d.bot_slug,
            d.price_cents,
            d.copy,
            d.button_intro_text,
            d.media_url,
            d.media_type,
            d.trigger,
            d.delay_minutes,
            d.sort_order,
            d.active,
            d.plan_label,
            d.plan_id,
            COALESCE(d.extra_plans, '[]'::jsonb) AS extra_plans,
            d.created_at,
            d.updated_at
       FROM bot_downsells d
      WHERE d.id = $1
      LIMIT 1`,
    [id]
  );

  const row = rows[0];
  return row ? mapRow(row) : null;
}

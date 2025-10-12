import { pool } from './pool.js';

export interface BotPlan {
  id: number;
  bot_slug: string;
  plan_name: string;
  price_cents: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertPlanInput {
  id?: number;
  bot_slug: string;
  plan_name: string;
  price_cents: number;
  is_active?: boolean;
}

function mapRow(row: any): BotPlan {
  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    plan_name: String(row.plan_name),
    price_cents: Number(row.price_cents),
    is_active: Boolean(row.is_active),
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

export async function listPlans(botSlug: string): Promise<BotPlan[]> {
  const result = await pool.query(
    `select id, bot_slug, plan_name, price_cents, is_active, created_at, updated_at
       from bot_plans
      where bot_slug = $1
      order by is_active desc, id asc`,
    [botSlug]
  );

  return result.rows.map(mapRow);
}

export async function getPlanById(id: number): Promise<BotPlan | null> {
  const result = await pool.query(
    `select id, bot_slug, plan_name, price_cents, is_active, created_at, updated_at
       from bot_plans
      where id = $1`,
    [id]
  );

  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function upsertPlan(input: UpsertPlanInput): Promise<BotPlan | null> {
  const isActive = input.is_active ?? true;

  if (input.id) {
    const result = await pool.query(
      `update bot_plans
          set plan_name = $2,
              price_cents = $3,
              is_active = $4,
              updated_at = now()
        where id = $1 and bot_slug = $5
        returning *`,
      [input.id, input.plan_name, input.price_cents, isActive, input.bot_slug]
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  const result = await pool.query(
    `insert into bot_plans (bot_slug, plan_name, price_cents, is_active)
     values ($1, $2, $3, $4)
     returning *`,
    [input.bot_slug, input.plan_name, input.price_cents, isActive]
  );

  return mapRow(result.rows[0]);
}

export async function deletePlan(id: number, botSlug: string): Promise<boolean> {
  const result = await pool.query(`delete from bot_plans where id = $1 and bot_slug = $2`, [id, botSlug]);
  return (result.rowCount ?? 0) > 0;
}

import { pool } from '../db/pool.js';
import type { ShotPlanRow } from './ShotsRepo.js';

function mapPlanRow(row: any): ShotPlanRow {
  return {
    id: Number(row.id),
    shot_id: Number(row.shot_id),
    name: String(row.name ?? ''),
    price_cents: Number.isFinite(row.price_cents) ? Number(row.price_cents) : 0,
    description: row.description ?? null,
    sort_order: Number.isFinite(row.sort_order) ? Number(row.sort_order) : 0,
  };
}

export async function listPlans(shotId: number): Promise<ShotPlanRow[]> {
  const { rows } = await pool.query(
    `SELECT id, shot_id, name, price_cents, description, sort_order
     FROM shot_plans
     WHERE shot_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [shotId]
  );

  return rows.map(mapPlanRow);
}

export async function getPlanById(planId: number): Promise<ShotPlanRow | null> {
  const { rows } = await pool.query(
    `SELECT id, shot_id, name, price_cents, description, sort_order
     FROM shot_plans
     WHERE id = $1
     LIMIT 1`,
    [planId]
  );

  return rows.length > 0 ? mapPlanRow(rows[0]) : null;
}

export interface CreatePlanInput {
  shot_id: number;
  name: string;
  price_cents: number;
  description: string | null;
}

export async function createPlan(input: CreatePlanInput): Promise<ShotPlanRow> {
  const { rows: sortRows } = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
     FROM shot_plans
     WHERE shot_id = $1`,
    [input.shot_id]
  );

  const rawNext = Number(sortRows[0]?.next ?? 0);
  const sortOrder = Number.isFinite(rawNext) ? rawNext : 0;

  const { rows } = await pool.query(
    `INSERT INTO shot_plans (shot_id, name, price_cents, description, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, shot_id, name, price_cents, description, sort_order`,
    [input.shot_id, input.name, input.price_cents, input.description, sortOrder]
  );

  return mapPlanRow(rows[0]);
}

export interface UpdatePlanInput {
  name?: string;
  price_cents?: number;
  description?: string | null;
}

export async function updatePlan(
  shotId: number,
  planId: number,
  input: UpdatePlanInput
): Promise<ShotPlanRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    sets.push(`${key} = $${index}`);
    values.push(value);
    index += 1;
  }

  if (sets.length === 0) {
    return getPlanById(planId);
  }

  values.push(shotId);
  values.push(planId);

  const { rows } = await pool.query(
    `UPDATE shot_plans
     SET ${sets.join(', ')}
     WHERE shot_id = $${index} AND id = $${index + 1}
     RETURNING id, shot_id, name, price_cents, description, sort_order`,
    values
  );

  return rows.length > 0 ? mapPlanRow(rows[0]) : null;
}

export async function deletePlan(shotId: number, planId: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM shot_plans WHERE shot_id = $1 AND id = $2', [
    shotId,
    planId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export async function reorderPlans(shotId: number, order: number[]): Promise<ShotPlanRow[]> {
  let position = 0;
  for (const planId of order) {
    await pool.query('UPDATE shot_plans SET sort_order = $1 WHERE shot_id = $2 AND id = $3', [
      position,
      shotId,
      planId,
    ]);
    position += 1;
  }

  return listPlans(shotId);
}


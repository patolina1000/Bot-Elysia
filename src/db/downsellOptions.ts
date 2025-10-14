import { pool } from './pool.js';
import type { DownsellOption } from './types.js';

export function mapDownsellOption(row: any): DownsellOption {
  return {
    id: Number(row.id),
    downsell_id: Number(row.downsell_id),
    label: String(row.label ?? ''),
    price_cents: Number(row.price_cents ?? 0),
    active: row.active === true || row.active === 't' || row.active === 1,
    sort_order: Number(row.sort_order ?? 0),
    media_url: row.media_url ? String(row.media_url) : null,
    media_type: row.media_type ? String(row.media_type) : null,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at
          ? new Date(row.created_at).toISOString()
          : undefined,
    updated_at:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at
          ? new Date(row.updated_at).toISOString()
          : undefined,
  };
}

const baseSelect = `
  SELECT id,
         downsell_id,
         label,
         price_cents,
         active,
         sort_order,
         media_url,
         media_type,
         created_at,
         updated_at
    FROM downsell_options
`;

export async function listOptions(downsell_id: number, onlyActive = false): Promise<DownsellOption[]> {
  const values: unknown[] = [downsell_id];
  const conditions: string[] = ['downsell_id = $1'];
  if (onlyActive) {
    conditions.push('active = true');
  }
  const sql = `${baseSelect} WHERE ${conditions.join(' AND ')} ORDER BY sort_order ASC, id ASC`;
  const { rows } = await pool.query(sql, values);
  return rows.map(mapDownsellOption);
}

export async function getOption(id: number): Promise<DownsellOption | null> {
  const { rows } = await pool.query(`${baseSelect} WHERE id = $1 LIMIT 1`, [id]);
  const row = rows[0];
  return row ? mapDownsellOption(row) : null;
}

export async function createOption(
  opt: Omit<DownsellOption, 'id' | 'created_at' | 'updated_at'>
): Promise<DownsellOption> {
  const values = [
    opt.downsell_id,
    opt.label,
    opt.price_cents,
    opt.active,
    opt.sort_order,
    opt.media_url ?? null,
    opt.media_type ?? null,
  ];
  const { rows } = await pool.query(
    `
      INSERT INTO downsell_options (downsell_id, label, price_cents, active, sort_order, media_url, media_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
    values
  );
  return mapDownsellOption(rows[0]);
}

export async function updateOption(
  id: number,
  patch: Partial<DownsellOption>
): Promise<DownsellOption | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.label !== undefined) {
    values.push(patch.label);
    sets.push(`label = $${values.length}`);
  }
  if (patch.price_cents !== undefined) {
    values.push(patch.price_cents);
    sets.push(`price_cents = $${values.length}`);
  }
  if (patch.active !== undefined) {
    values.push(patch.active);
    sets.push(`active = $${values.length}`);
  }
  if (patch.sort_order !== undefined) {
    values.push(patch.sort_order);
    sets.push(`sort_order = $${values.length}`);
  }
  if (patch.media_url !== undefined) {
    values.push(patch.media_url ?? null);
    sets.push(`media_url = $${values.length}`);
  }
  if (patch.media_type !== undefined) {
    values.push(patch.media_type ?? null);
    sets.push(`media_type = $${values.length}`);
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const sql = `
    UPDATE downsell_options
       SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING *
  `;

  const { rows } = await pool.query(sql, values);
  const row = rows[0];
  return row ? mapDownsellOption(row) : null;
}

export async function deleteOption(id: number): Promise<void> {
  await pool.query('DELETE FROM downsell_options WHERE id = $1', [id]);
}

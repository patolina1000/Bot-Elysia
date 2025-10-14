import { pool } from './pool.js';

export async function getBotIdBySlug(slug: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT id FROM bots WHERE slug = $1 LIMIT 1`, [slug]);
  const row = rows[0];
  return row ? String(row.id) : null;
}

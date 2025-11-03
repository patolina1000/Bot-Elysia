import pg from 'pg';
import { env } from '../src/env.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

async function hasPgcrypto() {
  const { rows } = await pool.query(`SELECT 1 FROM pg_extension WHERE extname='pgcrypto'`);
  return rows.length > 0;
}

async function hasUniqueIndexByName(table: string, names: string[]) {
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1`,
    [table]
  );
  const set = new Set(rows.map(r => r.indexname));
  return names.some(n => set.has(n));
}

async function hasUniqueIndexByCols(table: string, cols: string[]) {
  const sql = `
    SELECT i.indisunique AS unique, array_agg(a.attname ORDER BY a.attnum) AS cols
    FROM pg_index i
    JOIN pg_class t  ON t.oid = i.indrelid
    JOIN pg_class ix ON ix.oid = i.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
    WHERE t.relname = $1
    GROUP BY i.indisunique, i.indexrelid
  `;
  const { rows } = await pool.query(sql, [table]);
  return rows.some(r => r.unique && JSON.stringify(r.cols) === JSON.stringify(cols));
}

async function main() {
  const problems: string[] = [];

  // 1) pgcrypto
  if (!(await hasPgcrypto())) {
    problems.push('pgcrypto extension is missing');
  }

  // 2) funnel_events(event_id) unique idx (by name OR by cols)
  const funnelOkByName = await hasUniqueIndexByName('funnel_events', ['ux_funnel_event_id', 'idx_funnel_events_event_id']);
  const funnelOkByCols = await hasUniqueIndexByCols('funnel_events', ['event_id']);
  if (!(funnelOkByName || funnelOkByCols)) {
    problems.push('Missing UNIQUE index on funnel_events(event_id)');
  }

  // 3) bots(slug) unique
  const botsByName = await hasUniqueIndexByName('bots', ['ux_bots_slug']);
  const botsByCols = await hasUniqueIndexByCols('bots', ['slug']);
  if (!(botsByName || botsByCols)) {
    problems.push('Missing UNIQUE index on bots(slug)');
  }

  // 4) users(bot_id, tg_user_id) unique (users pode não existir em todos ambientes)
  try {
    const usersByName = await hasUniqueIndexByName('users', ['ux_users_bot_tg']);
    const usersByCols = await hasUniqueIndexByCols('users', ['bot_id','tg_user_id']);
    if (!(usersByName || usersByCols)) {
      problems.push('Missing UNIQUE index on users(bot_id, tg_user_id)');
    }
  } catch {
    // tabela users pode não existir; ignore aqui
  }

  if (problems.length > 0) {
    console.error('[check:core-schema] FAILED:\n- ' + problems.join('\n- '));
    await pool.end();
    process.exit(1);
  }

  console.log('[check:core-schema] OK');
  await pool.end();
}

void main();

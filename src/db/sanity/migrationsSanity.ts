import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL ausente'); process.exit(1); }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tbl = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('bot_settings','tg_bot_settings')
      ORDER BY table_name
    `);
    const tableName = tbl.rows[0]?.table_name ?? '(nenhuma)';

    const offers = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=COALESCE($1,'__x__') AND column_name='offers_text' LIMIT 1
    `, [tbl.rows[0]?.table_name]);

    const evIdx = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND tablename='funnel_events'
        AND (indexname ILIKE '%event_id%' OR indexdef ILIKE '%(event_id)%')
    `);

    const occIdx = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND tablename='funnel_events'
        AND indexname='ix_funnel_occurred_at'
    `);

    console.log('SANITY: tabela settings =', tableName);
    console.log('SANITY: offers_text =', offers.rowCount ? 'OK' : 'FALTA/IGNORADA');
    console.log('SANITY: idx event_id =', evIdx.rowCount ? 'OK' : 'FALTA');
    console.log('SANITY: idx occurred_at =', occIdx.rowCount ? 'OK' : 'FALTA');
  } finally {
    await client.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });

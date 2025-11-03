import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL ausente');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    // Qual tabela de settings existe?
    const tbl = await client.query<{
      table_name: string;
    }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN ('bot_settings','tg_bot_settings')
      ORDER BY table_name
    `);

    const tableName = tbl.rows[0]?.table_name;
    if (!tableName) {
      console.log('SANITY: nenhuma tabela de settings (bot_settings/tg_bot_settings) encontrada.');
      process.exit(0);
    }

    // Coluna offers_text existe?
    const col = await client.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=$1
        AND column_name='offers_text'
      LIMIT 1
    `, [tableName]);

    console.log(`SANITY: tabela de settings = ${tableName}`);
    console.log(`SANITY: offers_text = ${col.rowCount ? 'OK (existe)' : 'NÃO EXISTE'}`);

    // Extra: existência de funnel_events.event_id único
    const idx = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname='public'
        AND tablename='funnel_events'
        AND (indexname ILIKE '%event_id%' OR indexdef ILIKE '%(event_id)%')
    `);
    console.log(`SANITY: índice de dedup em funnel_events(event_id) = ${idx.rowCount ? 'OK' : 'FALTA'}`);

  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

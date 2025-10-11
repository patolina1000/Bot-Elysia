import pg from 'pg';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[check-core-start] DATABASE_URL not set.');
    process.exit(1);
    return;
  }

  const pool = new pg.Pool({ connectionString });

  try {
    const result = await pool.query<{
      id: string;
      slug: string;
    }>(
      `SELECT b.id, b.slug
       FROM bots b
       JOIN bot_features f ON f.bot_id = b.id
       WHERE f.key = 'core-start' AND f.enabled = false`
    );

    if (result.rows.length > 0) {
      console.error('[check-core-start] Found bots with core-start disabled explicitly:');
      for (const row of result.rows) {
        console.error(` - ${row.slug} (${row.id})`);
      }
      process.exit(1);
    } else {
      console.log('[check-core-start] All bots have core-start enabled (or default).');
    }
  } catch (error) {
    console.error('[check-core-start] Failed to verify core-start flags:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void main();

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { Client } from 'pg';

function sha256(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex');
}

async function detectTable(client: Client): Promise<{
  schema: string;
  table: string;
  fileCol: 'file' | 'filename';
  hasAppliedAt: boolean;
}> {
  const q = `
    SELECT c.table_schema, c.table_name,
           MAX(CASE WHEN c.column_name='file' THEN 1 ELSE 0 END) has_file,
           MAX(CASE WHEN c.column_name='filename' THEN 1 ELSE 0 END) has_filename,
           MAX(CASE WHEN c.column_name='checksum' THEN 1 ELSE 0 END) has_checksum,
           MAX(CASE WHEN c.column_name='applied_at' THEN 1 ELSE 0 END) has_applied_at
    FROM information_schema.columns c
    GROUP BY c.table_schema, c.table_name
    HAVING (MAX(CASE WHEN c.column_name='file' THEN 1 ELSE 0 END)=1
            OR MAX(CASE WHEN c.column_name='filename' THEN 1 ELSE 0 END)=1)
       AND MAX(CASE WHEN c.column_name='checksum' THEN 1 ELSE 0 END)=1
  `;
  const r = await client.query(q);
  if (!r.rows.length) throw new Error('Não encontrei tabela de migrations');
  const pick =
    r.rows.find((x: any) => x.table_schema === 'public' && x.table_name === 'migrations') ??
    r.rows.find((x: any) => x.table_schema === 'public') ??
    r.rows[0];
  const fileCol = pick.has_file ? 'file' : 'filename';
  return {
    schema: pick.table_schema,
    table: pick.table_name,
    fileCol,
    hasAppliedAt: !!pick.has_applied_at,
  };
}

function listLocal(): { file: string; full: string; checksum: string }[] {
  const dirDist = path.resolve('dist/db/migrations');
  const dirSrc = path.resolve('src/db/migrations');
  const pick = fs.existsSync(dirDist) ? dirDist : dirSrc;
  if (!fs.existsSync(pick)) return [];
  return fs
    .readdirSync(pick)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const full = path.join(pick, f);
      const checksum = sha256(fs.readFileSync(full));
      return { file: f, full, checksum };
    });
}

async function main() {
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    console.error('DATABASE_URL ausente');
    process.exit(2);
  }

  const accept = process.argv.includes('--accept') || process.env.MIGRATIONS_ACCEPT === '1';

  const client = new Client({ connectionString: conn });
  await client.connect();

  try {
    const { schema, table, fileCol, hasAppliedAt } = await detectTable(client);
    const locals = listLocal();
    const mapLocal = new Map(locals.map((x) => [x.file, x]));

    const rows = await client.query<Record<string, any>>(`SELECT * FROM ${schema}."${table}"`);
    const diverged: { name: string; dbChecksum: string; localChecksum: string }[] = [];

    for (const row of rows.rows) {
      const name = (row[fileCol] ?? '').trim();
      const dbChecksum = (row.checksum ?? '').trim();
      const appliedAt = row.applied_at ?? row.appliedAt ?? null;
      if (!name) continue;
      const local = mapLocal.get(name);
      if (!local) {
        console.log(`NOT_FOUND ${name}  (registro no DB mas arquivo local ausente)`);
        continue;
      }
      if (!dbChecksum) continue;
      if (dbChecksum !== local.checksum) {
        if (hasAppliedAt && appliedAt) {
          diverged.push({ name, dbChecksum, localChecksum: local.checksum });
        } else {
          console.log(`SKIPPED  ${name}  (checksums diferem mas sem applied_at)`);
        }
      } else {
        console.log(`KEPT     ${name}`);
      }
    }

    if (!diverged.length) {
      console.log('Nada a reconciliar.');
      process.exit(0);
    }

    console.log('\nDIVERGED a reconciliar:');
    for (const d of diverged) {
      console.log(`- ${d.name}  DB:${d.dbChecksum.slice(0, 10)}...  LOCAL:${d.localChecksum.slice(0, 10)}...`);
    }

    if (!accept) {
      console.log('\nExecução SECA (sem --accept / MIGRATIONS_ACCEPT=1). Nenhuma linha atualizada.');
      process.exit(0);
    }

    for (const d of diverged) {
      const sql = `UPDATE ${schema}."${table}" SET checksum = $1 WHERE ${fileCol} = $2`;
      await client.query(sql, [d.localChecksum, d.name]);
      console.log(`ACCEPTED ${d.name}`);
    }

    console.log('\nReconciliation concluída.');
    process.exit(0);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

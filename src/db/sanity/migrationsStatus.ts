import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { Client } from 'pg';

type Row = { file?: string | null; filename?: string | null; checksum?: string | null; applied_at?: string | null };

type LocalMigration = { file: string; full: string };

type ResultRow = {
  file: string;
  status: 'APPLIED' | 'DIVERGED' | 'PENDING' | 'UNKNOWN';
  dbChecksum?: string;
  localChecksum?: string;
  appliedAt?: string;
};

function sha256(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex');
}

function listLocal(dir: string): LocalMigration[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, full: path.join(dir, f) }));
}

async function detectMigrationsTable(client: Client): Promise<{ schema: string; table: string } | null> {
  const q = `
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    GROUP BY c.table_schema, c.table_name
    HAVING BOOL_OR(c.column_name IN ('file','filename'))
       AND BOOL_OR(c.column_name = 'checksum')
  `;
  const r = await client.query(q);
  const preferred =
    r.rows.find((x: any) => x.table_schema === 'public' && x.table_name === 'migrations') ??
    r.rows.find((x: any) => x.table_schema === 'public') ??
    r.rows[0];
  return preferred ? { schema: preferred.table_schema, table: preferred.table_name } : null;
}

async function main() {
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    console.error('DATABASE_URL ausente');
    process.exit(2);
  }

  const client = new Client({ connectionString: conn });
  await client.connect();

  try {
    const holder = await detectMigrationsTable(client);
    if (!holder) {
      console.log('Nenhuma tabela de migrations encontrada.');
      process.exit(0);
    }
    const { schema, table } = holder;

    const db = await client.query<Row>(`SELECT * FROM ${schema}."${table}" ORDER BY 1`);
    const dbMap = new Map<string, Row>();
    for (const r of db.rows) {
      const name = (r.file ?? r.filename ?? '').trim();
      if (name) dbMap.set(name, r);
    }

    const dirDist = path.resolve('dist/db/migrations');
    const dirSrc = path.resolve('src/db/migrations');
    const local = listLocal(dirDist).length ? listLocal(dirDist) : listLocal(dirSrc);

    const seen = new Set<string>();
    const results: ResultRow[] = [];

    for (const f of local) {
      const content = fs.readFileSync(f.full);
      const localChecksum = sha256(content);
      const dbr = dbMap.get(f.file);
      if (!dbr) {
        results.push({ file: f.file, status: 'PENDING', localChecksum });
      } else {
        seen.add(f.file);
        const dbChecksum = (dbr.checksum ?? '').trim();
        const appliedAt = dbr.applied_at ?? undefined;
        if (dbChecksum && dbChecksum === localChecksum) {
          results.push({ file: f.file, status: 'APPLIED', dbChecksum, localChecksum, appliedAt });
        } else {
          results.push({ file: f.file, status: 'DIVERGED', dbChecksum, localChecksum, appliedAt });
        }
      }
    }

    for (const [name, dbr] of dbMap.entries()) {
      if (!seen.has(name)) {
        results.push({ file: name, status: 'UNKNOWN', dbChecksum: dbr.checksum ?? undefined, appliedAt: dbr.applied_at ?? undefined });
      }
    }

    const pad = (s: string, l: number) => s.toString().padEnd(l);
    console.log(pad('STATUS', 10), pad('FILE', 40), 'DB_CHECKSUM ... LOCAL_CHECKSUM ... APPLIED_AT');
    for (const r of results.sort((a, b) => a.file.localeCompare(b.file))) {
      console.log(
        pad(r.status, 10),
        pad(r.file, 40),
        (r.dbChecksum ?? '').slice(0, 10),
        '...',
        (r.localChecksum ?? '').slice(0, 10),
        '...',
        r.appliedAt ?? ''
      );
    }

    const diverged = results.some((r) => r.status === 'DIVERGED');
    process.exit(diverged ? 1 : 0);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

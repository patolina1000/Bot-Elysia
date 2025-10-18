import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pool } from '../src/db/pool.js';

const FIX_EOL_FLAG = '--fix-eol';

type MigrationStatus = 'OK' | 'EOL_ONLY' | 'MISMATCH' | 'NOT_APPLIED';

type MigrationResult = {
  filename: string;
  status: MigrationStatus;
  suggestion?: string;
};

function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(__dirname, './migrations'),
    path.resolve(process.cwd(), 'dist/db/migrations'),
    path.resolve(process.cwd(), 'src/db/migrations'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (error) {
      // ignore
    }
  }

  return path.resolve(__dirname, './migrations');
}

const MIGRATIONS_DIR = resolveMigrationsDir();

function listRootSqlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

function sha1(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}

function normalizeEol(sql: string): string {
  return sql.replace(/\r\n/g, '\n');
}

function stripBom(sql: string): string {
  return sql.replace(/^\uFEFF/, '');
}

function formatSuggestion(file: string): string {
  const base = path.basename(file, '.sql');
  const parts = base.split('_');
  const suffix = parts.length > 1 ? parts.slice(1).join('_') : base;
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const suggestionBase = suffix.endsWith('_v2') ? suffix : `${suffix}_v2`;
  return `${yyyy}${mm}${dd}_${suggestionBase}.sql`;
}

async function main() {
  const fixEol = process.argv.includes(FIX_EOL_FLAG);
  const files = listRootSqlFiles(MIGRATIONS_DIR);

  const client = await pool.connect();

  try {
    const { rows } = await client.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum FROM _schema_migrations`
    );
    const checksumMap = new Map(rows.map((row) => [row.filename, row.checksum]));

    const results: MigrationResult[] = [];
    let mismatchCount = 0;

    for (const file of files) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const sqlBuffer = fs.readFileSync(fullPath);
      const sql = stripBom(sqlBuffer.toString('utf8'));
      const checksumRaw = sha1(sql);
      const checksumNormalized = sha1(normalizeEol(sql));
      const existingChecksum = checksumMap.get(file);

      let status: MigrationStatus;
      let suggestion: string | undefined;

      if (!existingChecksum) {
        status = 'NOT_APPLIED';
      } else if (existingChecksum === checksumRaw) {
        status = 'OK';
      } else if (existingChecksum === checksumNormalized) {
        status = 'EOL_ONLY';
        if (fixEol) {
          await client.query(
            `UPDATE _schema_migrations SET checksum = $1 WHERE filename = $2`,
            [checksumRaw, file]
          );
        }
      } else {
        status = 'MISMATCH';
        suggestion = formatSuggestion(file);
        mismatchCount += 1;
      }

      results.push({ filename: file, status, suggestion });
    }

    console.table(
      results.map(({ filename, status, suggestion }) => ({
        filename,
        status,
        suggestion: status === 'MISMATCH' ? suggestion : '',
      }))
    );

    const summary = results.reduce(
      (acc, { status }) => {
        acc[status] += 1;
        return acc;
      },
      {
        OK: 0,
        EOL_ONLY: 0,
        MISMATCH: 0,
        NOT_APPLIED: 0,
      } as Record<MigrationStatus, number>
    );

    console.log(
      `Summary: OK=${summary.OK}, EOL_ONLY=${summary.EOL_ONLY}, MISMATCH=${summary.MISMATCH}, NOT_APPLIED=${summary.NOT_APPLIED}`
    );

    if (fixEol && summary.EOL_ONLY > 0) {
      console.log('Normalized checksums for files with EOL_ONLY differences.');
    }

    if (summary.MISMATCH > 0) {
      console.log('Suggested renames for mismatched files:');
      for (const { filename, status, suggestion } of results) {
        if (status === 'MISMATCH' && suggestion) {
          console.log(` - ${filename} -> ${suggestion}`);
        }
      }
    }

    if (mismatchCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

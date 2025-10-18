import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "./pool";

// Resolve diretório de migrações de forma robusta (dist e src)
function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(__dirname, "./migrations"),           // quando rodando do dist
    path.resolve(process.cwd(), "dist/db/migrations"), // fallback
    path.resolve(process.cwd(), "src/db/migrations"),  // dev/ts-node
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  // último recurso: __dirname/migrations
  return path.resolve(__dirname, "./migrations");
}

const MIGRATIONS_DIR = resolveMigrationsDir();

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function sha1(s: string) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function listRootSqlFiles(dir: string): string[] {
  // Somente arquivos .sql diretamente na pasta (ignora subpastas tipo _archived)
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((d) => d.isFile() && d.name.endsWith(".sql"))
    .map((d) => d.name)
    .sort(); // ordem lexicográfica
}

function logSqlContext(sql: string, posStr: string | undefined, file: string) {
  if (!posStr) {
    console.error(`[migrations] (sem posição) falha em ${file}`);
    return;
  }
  const pos = Number(posStr);
  if (!Number.isFinite(pos)) {
    console.error(`[migrations] (posição inválida) falha em ${file}`);
    return;
  }
  const start = Math.max(0, pos - 200);
  const end = Math.min(sql.length, pos + 200);
  const excerpt = sql.slice(start, end);
  console.error(`[migrations] contexto @${pos} em ${file}:\n---\n${excerpt}\n---`);
}

async function run() {
  await ensureMigrationsTable();
  const files = listRootSqlFiles(MIGRATIONS_DIR);

  const client = await pool.connect();
  try {
    for (const file of files) {
      const full = path.join(MIGRATIONS_DIR, file);
      const sqlRaw = fs.readFileSync(full);
      const sql = sqlRaw.toString("utf8").replace(/^\uFEFF/, "");
      const checksumRaw = sha1(sql);
      const checksumNormalized = sha1(sql.replace(/\r\n/g, "\n"));

      const { rows: existingRows } = await client.query(
        `SELECT checksum FROM _schema_migrations WHERE filename = $1`,
        [file]
      );
      if (existingRows.length) {
        const existingChecksum = existingRows[0].checksum;
        if (existingChecksum === checksumRaw) {
          console.log(`[migrations] skip ${file} (same checksum)`);
          continue;
        }
        if (existingChecksum === checksumNormalized) {
          await client.query(
            `UPDATE _schema_migrations SET checksum = $1 WHERE filename = $2`,
            [checksumRaw, file]
          );
          console.log(
            `[migrations] normalized checksum updated for ${file} (EOL normalized)`
          );
          continue;
        }
        throw new Error(
          `Checksum mismatch for migration ${file}.` +
            " Renomeie o arquivo ou reverta a alteração."
        );
      }

      console.log(`[migrations] applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO _schema_migrations (filename, checksum) VALUES ($1, $2)`,
          [file, checksumRaw]
        );
        await client.query("COMMIT");
      } catch (e: any) {
        await client.query("ROLLBACK");
        console.error(`[migrations] failed at ${file}: ${e?.message || e}`);
        logSqlContext(sql, e?.position, file);
        throw e;
      }
    }

    console.log("All migrations completed successfully");
  } finally {
    client.release();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

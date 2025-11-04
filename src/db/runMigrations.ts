import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "./pool";
import { logger } from "../logger";

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

const MIGRATIONS_FORCE_RAW = process.env.MIGRATIONS_FORCE === "1";
const MIGRATIONS_FORCE_ACK = process.env.MIGRATIONS_FORCE_ACK === "1";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

if (MIGRATIONS_FORCE_RAW && IS_PRODUCTION && !MIGRATIONS_FORCE_ACK) {
  logger.error(
    {
      MIGRATIONS_FORCE: MIGRATIONS_FORCE_RAW,
      NODE_ENV: process.env.NODE_ENV,
    },
    "[migrations] MIGRATIONS_FORCE está bloqueado em produção. Use reconcileMigrations ou defina MIGRATIONS_FORCE_ACK=1 conscientemente."
  );
  throw new Error(
    "MIGRATIONS_FORCE não é permitido em produção sem MIGRATIONS_FORCE_ACK."
  );
}

const MIGRATIONS_FORCE = MIGRATIONS_FORCE_RAW && (!IS_PRODUCTION || MIGRATIONS_FORCE_ACK);

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
    logger.error({ file }, "[migrations] (sem posição) falha");
    return;
  }
  const pos = Number(posStr);
  if (!Number.isFinite(pos)) {
    logger.error({ file, position: posStr }, "[migrations] (posição inválida) falha");
    return;
  }
  const start = Math.max(0, pos - 200);
  const end = Math.min(sql.length, pos + 200);
  const excerpt = sql.slice(start, end);
  logger.error({ file, position: pos, excerpt }, "[migrations] contexto de falha");
}

function isNonTransactionalMigration(filename: string, sql: string): boolean {
  const loweredSql = sql.toLowerCase();
  const trimmedSql = loweredSql.trimStart();
  if (trimmedSql.startsWith("-- no_tx") || trimmedSql.startsWith("--no_tx")) {
    return true;
  }
  if (loweredSql.includes("lock table")) {
    return true;
  }
  if (loweredSql.includes("create index concurrently")) {
    return true;
  }
  if (loweredSql.includes("do $$")) {
    return true;
  }
  if (loweredSql.includes("begin;")) {
    return true;
  }
  if (loweredSql.includes("alter type")) {
    return true;
  }
  if (filename.toLowerCase().includes("shots") && sql.length > 30_000) {
    return true;
  }
  return false;
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
          logger.info({ file }, "[migrations] skip (same checksum)");
          continue;
        }
        if (existingChecksum === checksumNormalized) {
          await client.query(
            `UPDATE _schema_migrations SET checksum = $1 WHERE filename = $2`,
            [checksumRaw, file]
          );
          logger.info(
            { file },
            "[migrations] normalized checksum updated (EOL normalized)"
          );
          continue;
        }
        if (MIGRATIONS_FORCE) {
          logger.warn(
            {
              file,
              dbChecksum: existingChecksum,
              fileChecksum: checksumRaw,
            },
            "[migrations] checksum mismatch (IGNORANDO GUARD POR MIGRATIONS_FORCE)"
          );
          continue;
        }
        throw new Error(
          `Checksum mismatch for migration ${file}.` +
            " Renomeie o arquivo ou reverta a alteração."
        );
      }

      if (file.includes("_archived") || file.endsWith(".ignore")) {
        logger.info({ file }, "Skipping archived migration");
        continue;
      }

      const isNoTx = isNonTransactionalMigration(file, sql);
      logger.info({ file, transactional: !isNoTx }, "Running migration");

      if (isNoTx) {
        logger.warn({ file }, "Migration marked as NO_TX, running without transaction");
        try {
          await client.query(sql);
          await client.query(
            `INSERT INTO _schema_migrations (filename, checksum) VALUES ($1, $2)`,
            [file, checksumRaw]
          );
        } catch (e: any) {
          logger.error({ file, err: e }, "Migration failed");
          logSqlContext(sql, e?.position, file);
          throw e;
        }
        continue;
      }

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
        logger.error({ file, err: e }, "Migration failed");
        logSqlContext(sql, e?.position, file);
        throw e;
      }
    }

    logger.info("All migrations completed successfully");
  } finally {
    client.release();
  }
}

run().catch((e) => {
  logger.error({ err: e }, "Migration runner failed");
  process.exit(1);
});

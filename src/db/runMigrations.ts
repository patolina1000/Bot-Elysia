import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "./pool";

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

async function alreadyApplied(filename: string) {
  const { rows } = await pool.query(
    "SELECT 1 FROM _schema_migrations WHERE filename=$1",
    [filename]
  );
  return rows.length > 0;
}

async function recordApplied(filename: string, checksum: string) {
  await pool.query(
    "INSERT INTO _schema_migrations (filename, checksum) VALUES ($1,$2) ON CONFLICT (filename) DO NOTHING",
    [filename, checksum]
  );
}

async function run() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable();

    const dir = path.resolve(__dirname, "migrations");
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();

    for (const f of files) {
      if (await alreadyApplied(f)) {
        console.log(`[migrate] skip (already) ${f}`);
        continue;
      }
      const full = path.join(dir, f);
      const sql = fs.readFileSync(full, "utf8");
      const checksum = sha1(sql);

      console.log(`[migrate] applying ${f}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await recordApplied(f, checksum);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
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
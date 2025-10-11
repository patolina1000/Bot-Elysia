import fs from "fs";
import path from "path";
import { pool } from "./pool.js";

async function run() {
  const client = await pool.connect();
  try {
    const dir = path.resolve(__dirname, "migrations");
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      console.log(`[migrate] applying ${f}`);
      await client.query(sql);
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

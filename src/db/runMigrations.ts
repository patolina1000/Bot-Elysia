import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const migrations = [
  '000_enable_pgcrypto.sql',
  '001_core_tables.sql',
  '002_indexes.sql',
];

async function runMigrations() {
  logger.info('Starting database migrations...');

  for (const migrationFile of migrations) {
    try {
      const filePath = join(__dirname, 'migrations', migrationFile);
      const sql = readFileSync(filePath, 'utf-8');
      
      logger.info({ migration: migrationFile }, 'Running migration');
      await pool.query(sql);
      logger.info({ migration: migrationFile }, 'Migration completed');
    } catch (err) {
      logger.error({ err, migration: migrationFile }, 'Migration failed');
      throw err;
    }
  }

  logger.info('All migrations completed successfully');
  await pool.end();
}

runMigrations().catch((err) => {
  logger.error({ err }, 'Fatal error during migrations');
  process.exit(1);
});

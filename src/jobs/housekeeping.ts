import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

async function housekeeping() {
  logger.info('Running housekeeping job...');

  try {
    // Delete old logs (> 14 days)
    const result = await pool.query(
      `DELETE FROM app_logs WHERE created_at < now() - interval '14 days'`
    );

    logger.info({ deletedRows: result.rowCount }, 'Deleted old logs');

    // Add more housekeeping tasks here as needed
    // - Delete old funnel events
    // - Clean up inactive users
    // etc.

    logger.info('Housekeeping job completed');
  } catch (err) {
    logger.error({ err }, 'Error running housekeeping job');
  } finally {
    await pool.end();
  }
}

housekeeping();

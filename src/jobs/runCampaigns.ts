import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

async function runCampaigns() {
  logger.info('Running campaigns job...');

  try {
    const result = await pool.query(
      `SELECT * FROM campaigns WHERE status = 'active' ORDER BY created_at`
    );

    logger.info({ count: result.rows.length }, 'Found active campaigns');

    for (const campaign of result.rows) {
      logger.info({ campaignId: campaign.id, name: campaign.name }, 'Processing campaign');
      
      // Stub: Process campaign logic here
      // - Load filters
      // - Query users based on filters
      // - Send messages in batches
      // - Update campaign status
    }

    logger.info('Campaigns job completed');
  } catch (err) {
    logger.error({ err }, 'Error running campaigns job');
  } finally {
    await pool.end();
  }
}

runCampaigns();

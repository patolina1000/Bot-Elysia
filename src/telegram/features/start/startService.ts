import { pool } from '../../../db/pool.js';
import { mediaService } from '../../../services/MediaService.js';

export interface StartTemplate {
  text: string;
  parse_mode: string;
}

export class StartService {
  async getStartTemplate(botId: string): Promise<StartTemplate | null> {
    const result = await pool.query(
      `SELECT text, parse_mode FROM templates_start WHERE bot_id = $1`,
      [botId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async saveStartTemplate(
    botId: string,
    text: string,
    parseMode: string,
    media: Array<{ type: string; media: string }>
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Upsert template
      await client.query(
        `INSERT INTO templates_start (bot_id, text, parse_mode, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (bot_id) 
         DO UPDATE SET text = $2, parse_mode = $3, updated_at = now()`,
        [botId, text, parseMode]
      );

      // Delete existing media for this bot
      await mediaService.deleteMediaByBotId(botId);

      // Insert new media
      for (const item of media) {
        await mediaService.createMedia({
          bot_id: botId,
          kind: item.type as 'photo' | 'video' | 'audio',
          source_url: item.media,
        });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const startService = new StartService();

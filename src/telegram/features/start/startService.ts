import { pool } from '../../../db/pool.js';
import { mediaService } from '../../../services/MediaService.js';

export interface StartTemplate {
  text: string;
  parse_mode: string;
  start_messages?: string[];
}

export class StartService {
  async getStartTemplate(botId: string): Promise<StartTemplate | null> {
    const result = await pool.query(
      `SELECT text, parse_mode, start_messages FROM templates_start WHERE bot_id = $1`,
      [botId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    // Normaliza start_messages: preferência pelo array, fallback para text
    let messages: string[] = [];
    if (Array.isArray(row.start_messages) && row.start_messages.length > 0) {
      messages = row.start_messages.map((m: any) => String(m).trim()).filter(Boolean);
    } else if (row.text) {
      messages = [String(row.text)];
    }

    return {
      text: row.text,
      parse_mode: row.parse_mode,
      start_messages: messages,
    };
  }

  async saveStartTemplate(
    botId: string,
    text: string,
    parseMode: string,
    media: Array<{ type: string; media: string }>,
    startMessages?: string[]
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Normaliza start_messages: se recebeu array, usa; senão converte text para array
      let messages: string[] = [];
      if (Array.isArray(startMessages) && startMessages.length > 0) {
        messages = startMessages.map(s => String(s).trim()).filter(Boolean).slice(0, 3);
      } else if (text) {
        messages = [String(text)];
      }

      // Mantém text como primeiro item do array para retrocompatibilidade
      const legacyText = messages[0] || '';

      // Upsert template com start_messages
      await client.query(
        `INSERT INTO templates_start (bot_id, text, parse_mode, start_messages, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (bot_id) 
         DO UPDATE SET text = $2, parse_mode = $3, start_messages = $4, updated_at = now()`,
        [botId, legacyText, parseMode, JSON.stringify(messages)]
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

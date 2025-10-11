import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { MediaAsset } from '../utils/mediaGrouping.js';

export interface CreateMediaParams {
  bot_id: string;
  kind: 'photo' | 'video' | 'audio';
  source_url?: string;
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export class MediaService {
  async createMedia(params: CreateMediaParams): Promise<string> {
    const result = await pool.query(
      `INSERT INTO media_assets (bot_id, kind, source_url, file_id, file_unique_id, width, height, duration)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        params.bot_id,
        params.kind,
        params.source_url || null,
        params.file_id || null,
        params.file_unique_id || null,
        params.width || null,
        params.height || null,
        params.duration || null,
      ]
    );

    return result.rows[0].id;
  }

  async getMediaByBotId(botId: string): Promise<MediaAsset[]> {
    const result = await pool.query(
      `SELECT id, kind, source_url, file_id, file_unique_id, width, height, duration
       FROM media_assets
       WHERE bot_id = $1
       ORDER BY created_at ASC`,
      [botId]
    );

    return result.rows;
  }

  async updateFileId(mediaId: string, fileId: string, fileUniqueId: string): Promise<void> {
    await pool.query(
      `UPDATE media_assets SET file_id = $2, file_unique_id = $3 WHERE id = $1`,
      [mediaId, fileId, fileUniqueId]
    );

    logger.debug({ mediaId, fileId }, 'Updated media file_id');
  }

  async deleteMediaByBotId(botId: string): Promise<void> {
    await pool.query(`DELETE FROM media_assets WHERE bot_id = $1`, [botId]);
    logger.info({ botId }, 'Deleted media for bot');
  }
}

export const mediaService = new MediaService();

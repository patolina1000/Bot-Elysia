import { Router, type Request, type Response } from 'express';
import { fetch } from 'undici';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';
import { pool } from '../db/pool.js';
import { getEncryptionKey, maskToken } from '../utils/crypto.js';
import { env } from '../env.js';
import { setWebhook } from '../utils/telegramApi.js';

interface CreateBotBody {
  slug?: string;
  token?: string;
  title?: string | null;
  secret?: string | null;
  setWebhook?: boolean;
  createEmptyTemplate?: boolean;
}

export const createBotRouter = Router();

createBotRouter.post('/admin/bots', authAdminMiddleware, async (req: Request, res: Response) => {
  const {
    slug,
    token,
    title,
    secret,
    setWebhook: shouldSetWebhook = true,
    createEmptyTemplate = true,
  } = (req.body ?? {}) as CreateBotBody;

  const normalizedSlug = typeof slug === 'string' ? slug.trim() : '';
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  const normalizedTitle = typeof title === 'string' ? title.trim() : '';
  const providedSecret = typeof secret === 'string' ? secret.trim() : '';

  if (!normalizedSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)) {
    return res.status(400).json({ error: 'invalid_slug' });
  }

  if (!normalizedToken) {
    return res.status(400).json({ error: 'invalid_token' });
  }

  try {
    const existing = await pool.query('SELECT id FROM bots WHERE slug = $1 LIMIT 1', [normalizedSlug]);
    if (existing.rowCount && existing.rows[0]) {
      return res.status(409).json({ error: 'slug_taken' });
    }

    let telegramInfo: any = null;
    try {
      const response = await fetch(`https://api.telegram.org/bot${normalizedToken}/getMe`);
      telegramInfo = await response.json().catch(() => null);
      if (!response.ok || !telegramInfo?.ok) {
        return res.status(400).json({ error: 'telegram_token_invalid', detail: telegramInfo });
      }
    } catch (error) {
      req.log?.error({ error }, 'Failed to validate Telegram token');
      return res.status(502).json({ error: 'telegram_validation_failed' });
    }

    const webhookSecret = providedSecret || env.ENCRYPTION_KEY;
    const baseUrl = env.APP_BASE_URL.replace(/\/+$/, '');
    const webhookUrl = `${baseUrl}/tg/${normalizedSlug}/webhook`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO bots (slug, name, token_encrypted, webhook_secret)
         VALUES ($1, $2, pgp_sym_encrypt($3::text, $4), $5)
         RETURNING id, slug, name, created_at`,
        [normalizedSlug, normalizedTitle || normalizedSlug, normalizedToken, getEncryptionKey(), webhookSecret],
      );

      const botRow = insertResult.rows[0];

      if (createEmptyTemplate) {
        await client.query(
          `INSERT INTO templates_start (bot_id, text, parse_mode, updated_at)
           VALUES ($1, '', 'Markdown', now())
           ON CONFLICT (bot_id) DO NOTHING`,
          [botRow.id],
        );
      }

      if (shouldSetWebhook) {
        const ok = await setWebhook(normalizedToken, {
          url: webhookUrl,
          secret_token: webhookSecret,
        });

        if (!ok) {
          throw new Error('failed_to_set_webhook');
        }
      }

      await client.query('COMMIT');

      return res.status(201).json({
        id: botRow.id,
        slug: botRow.slug,
        title: botRow.name,
        webhookUrl,
        created_at: botRow.created_at instanceof Date ? botRow.created_at.toISOString() : botRow.created_at,
        token_masked: maskToken(normalizedToken),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as Error).message === 'failed_to_set_webhook') {
        req.log?.error({ error: 'failed_to_set_webhook', slug: normalizedSlug }, 'Failed to set webhook for new bot');
        return res.status(502).json({ error: 'failed_to_set_webhook' });
      }
      req.log?.error({ error }, 'Failed to create bot');
      return res.status(500).json({ error: 'failed_to_create_bot' });
    } finally {
      client.release();
    }
  } catch (error) {
    req.log?.error({ error }, 'Unexpected error while creating bot');
    return res.status(500).json({ error: 'failed_to_create_bot' });
  }
});

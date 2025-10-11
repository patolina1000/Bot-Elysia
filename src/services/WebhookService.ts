import { setWebhook } from '../utils/telegramApi.js';
import { env } from '../env.js';
import { logger } from '../logger.js';

export class WebhookService {
  async registerWebhook(params: {
    token: string;
    slug: string;
    webhook_secret: string;
    allowed_updates?: string[];
  }): Promise<boolean> {
    const webhookUrl = `${env.APP_BASE_URL}/tg/${params.slug}/webhook`;

    const success = await setWebhook(params.token, {
      url: webhookUrl,
      secret_token: params.webhook_secret,
      allowed_updates: params.allowed_updates,
      drop_pending_updates: false,
    });

    if (success) {
      logger.info({ slug: params.slug, webhookUrl }, 'Webhook registered successfully');
    } else {
      logger.error({ slug: params.slug, webhookUrl }, 'Failed to register webhook');
    }

    return success;
  }
}

export const webhookService = new WebhookService();

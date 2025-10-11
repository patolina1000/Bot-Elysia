import { fetch } from "undici";
import { logger } from '../logger.js';

export interface SetWebhookParams {
  url: string;
  secret_token?: string;
  allowed_updates?: string[];
  drop_pending_updates?: boolean;
}

export async function setWebhook(token: string, params: SetWebhookParams): Promise<boolean> {
  const apiUrl = `https://api.telegram.org/bot${token}/setWebhook`;
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    const data = await response.json() as { ok: boolean; description?: string };

    if (!data.ok) {
      logger.error({ data, params: { ...params, url: params.url } }, 'Failed to set webhook');
      return false;
    }

    logger.info({ url: params.url }, 'Webhook set successfully');
    return true;
  } catch (err) {
    logger.error({ err, params: { ...params, url: params.url } }, 'Error setting webhook');
    return false;
  }
}

export async function deleteWebhook(token: string): Promise<boolean> {
  const apiUrl = `https://api.telegram.org/bot${token}/deleteWebhook`;
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
    });

    const data = await response.json() as { ok: boolean };
    return data.ok;
  } catch (err) {
    logger.error({ err }, 'Error deleting webhook');
    return false;
  }
}

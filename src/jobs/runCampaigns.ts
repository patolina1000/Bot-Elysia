import type { InlineKeyboardMarkup } from '@grammyjs/types';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { selectAudience, type AudienceMember } from '../services/shots/audienceSelector.js';
import { getOrCreateBotBySlug } from '../telegram/botFactory.js';
import { sendSafe } from '../utils/telegramErrorHandler.js';

// Tuning via env (opcionais)
const BATCH_SIZE = Number(process.env.CAMPAIGNS_BATCH_SIZE ?? 200);
const SLEEP_MS   = Number(process.env.CAMPAIGNS_SLEEP_MS   ?? 250);
const JITTER_MS  = Number(process.env.CAMPAIGNS_JITTER_MS  ?? 150);

type CampaignRow = {
  id: string;
  bot_id: string;
  name: string;
  status: string;
  filters_json: any;
  payload_json: any;
};

type Filters = {
  // Mapeamento para audienceSelector.ts
  // target: 'started' | 'pix_created'
  target?: 'started' | 'pix_created';
  recencyDays?: number;
};

type Button = { text: string; url?: string; };
type Media = { type: 'photo' | 'video' | 'audio' | 'document', url: string, caption?: string };

type Payload = {
  text?: string;
  buttons?: Button[];
  media?: Media;
  // Futuro: permitir templates, variáveis, etc.
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
  const { rows } = await pool.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) as locked', [key]);
  if (!rows[0]?.locked) {
    logger.warn('[CAMPAIGNS] Another instance is running (advisory lock failed)');
    return null;
  }
  try {
    return await fn();
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [key]);
  }
}

async function fetchNextActiveCampaignTx(client: any): Promise<CampaignRow | null> {
  // Seleciona 1 campanha ativa e faz lock para evitar concorrência
  const sql = `
    WITH c AS (
      SELECT *
      FROM campaigns
      WHERE status = 'active'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE campaigns
       SET status='running',
           started_at = now(),
           sent_count = 0,
           fail_count = 0,
           total_targets = NULL,
           last_error = NULL
     WHERE id IN (SELECT id FROM c)
     RETURNING *
  `;
  const { rows } = await client.query(sql);
  return rows[0] ?? null;
}

async function resolveBotSlug(botId: string): Promise<string | null> {
  const { rows } = await pool.query<{ slug: string }>('SELECT slug FROM bots WHERE id = $1', [botId]);
  return rows[0]?.slug ?? null;
}

function buildInlineKeyboard(buttons?: Button[]): InlineKeyboardMarkup | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  const rows = buttons
    .filter((button) => Boolean(button.url))
    .map((button) => [{ text: button.text, url: button.url! }]);
  if (rows.length === 0) return undefined;
  return { inline_keyboard: rows };
}

async function sendToAudience(
  botSlug: string,
  audience: AudienceMember[],
  payload: Payload
): Promise<{ sent: number; failed: number }> {
  const bot = await getOrCreateBotBySlug(botSlug);
  const api = bot.api;

  let sent = 0;
  let failed = 0;

  const keyboard = buildInlineKeyboard(payload.buttons);

  const sendOne = async (tgId: number) => {
    try {
      // 1) Media (se houver)
      if (payload.media && payload.media.url) {
        const m = payload.media;
        if (m.type === 'photo') {
          await sendSafe(() => api.sendPhoto(tgId, m.url, { caption: m.caption }), botSlug, tgId);
        } else if (m.type === 'video') {
          await sendSafe(() => api.sendVideo(tgId, m.url, { caption: m.caption }), botSlug, tgId);
        } else if (m.type === 'audio') {
          await sendSafe(() => api.sendAudio(tgId, m.url, { caption: m.caption }), botSlug, tgId);
        } else if (m.type === 'document') {
          await sendSafe(() => api.sendDocument(tgId, m.url, { caption: m.caption }), botSlug, tgId);
        }
      }

      // 2) Texto (se houver)
      if (payload.text && payload.text.trim().length > 0) {
        await sendSafe(
          () => api.sendMessage(tgId, payload.text!, keyboard ? { reply_markup: keyboard } : undefined),
          botSlug,
          tgId
        );
      }

      sent++;
    } catch (err) {
      failed++;
      logger.warn({ err, botSlug, tgId }, '[CAMPAIGNS] send failed');
    }
  };

  // Lotes com leve atraso/jitter para respeitar limites
  for (let i = 0; i < audience.length; i += BATCH_SIZE) {
    const batch = audience.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (m) => {
        await sendOne(m.telegram_id);
        // micro pausa para espalhar requests
        const jitter = Math.floor(Math.random() * JITTER_MS);
        await sleep(SLEEP_MS + jitter);
      })
    );

    logger.info({ botSlug, progress: `${Math.min(i + BATCH_SIZE, audience.length)}/${audience.length}` }, '[CAMPAIGNS] batch done');
  }

  return { sent, failed };
}

async function processOneCampaign(campaign: CampaignRow): Promise<void> {
  const campaignId = campaign.id;

  try {
    const botSlug = await resolveBotSlug(campaign.bot_id);
    if (!botSlug) {
      await pool.query(
        `UPDATE campaigns SET status='failed', finished_at=now(), last_error=$2 WHERE id=$1`,
        [campaignId, 'bot_slug_not_found']
      );
      logger.error({ campaignId }, '[CAMPAIGNS] bot slug not found');
      return;
    }

    // Normaliza filtros e payload
    const filters: Filters = {
      target: (campaign.filters_json?.target ?? 'started') as Filters['target'],
      recencyDays: Number(campaign.filters_json?.recencyDays ?? 0) || undefined,
    };

    const payload: Payload = {
      text: campaign.payload_json?.text ?? '',
      buttons: Array.isArray(campaign.payload_json?.buttons) ? campaign.payload_json.buttons : undefined,
      media: campaign.payload_json?.media,
    };

    // Seleciona audiência usando o serviço existente (shots/audienceSelector)
    const audience = await selectAudience({
      bot_slug: botSlug,
      target: filters.target ?? 'started',
      recencyDays: filters.recencyDays,
    });

    await pool.query(
      `UPDATE campaigns SET total_targets=$2 WHERE id=$1`,
      [campaignId, audience.length]
    );

    if (audience.length === 0) {
      await pool.query(
        `UPDATE campaigns SET status='completed', finished_at=now() WHERE id=$1`,
        [campaignId]
      );
      logger.info({ campaignId, botSlug }, '[CAMPAIGNS] empty audience, completed');
      return;
    }

    logger.info({ campaignId, botSlug, target: filters.target, total: audience.length }, '[CAMPAIGNS] sending…');

    const { sent, failed } = await sendToAudience(botSlug, audience, payload);

    await pool.query(
      `UPDATE campaigns
          SET status='completed',
              finished_at=now(),
              sent_count=$2,
              fail_count=$3
        WHERE id=$1`,
      [campaignId, sent, failed]
    );

    logger.info({ campaignId, botSlug, sent, failed }, '[CAMPAIGNS] completed');
  } catch (err) {
    logger.error({ err, campaignId: campaign.id }, '[CAMPAIGNS] failed');
    await pool.query(
      `UPDATE campaigns SET status='failed', finished_at=now(), last_error=$2 WHERE id=$1`,
      [campaignId, String((err as Error).message ?? err)]
    );
  }
}

async function main() {
  logger.info('[CAMPAIGNS] job starting');

  await withAdvisoryLock(911_2025, async () => {
    // Loop: pega uma campanha por vez
    while (true) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const campaign = await fetchNextActiveCampaignTx(client);
        await client.query('COMMIT');

        if (!campaign) {
          logger.info('[CAMPAIGNS] no active campaigns');
          break;
        }

        await processOneCampaign(campaign);
      } catch (err) {
        logger.error({ err }, '[CAMPAIGNS] tx error');
        try { await client.query('ROLLBACK'); } catch {}
        // Continua para tentar próxima
      } finally {
        client.release();
      }
    }
  });

  logger.info('[CAMPAIGNS] job finished');
  // Encerra o pool se o processo for one-shot
  await pool.end();
}

void main();

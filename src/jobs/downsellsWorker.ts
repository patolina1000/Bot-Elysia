import { pool } from '../db/pool.js';
import { getDownsell, findPendingToSend, markQueueSent, markQueueError } from '../db/downsells.js';
import { getEncryptionKey } from '../utils/crypto.js';
import { telegramMediaCache } from '../services/TelegramMediaCache.js';
import type { Logger } from 'pino';

async function getBotTokenBySlug(slug: string): Promise<{ token: string }> {
  const res = await pool.query(
    `SELECT pgp_sym_decrypt(token_encrypted, $1) AS token FROM bots WHERE slug = $2 LIMIT 1`,
    [getEncryptionKey(), slug]
  );
  if (!res.rows[0]?.token) throw new Error(`Token ausente para bot ${slug}`);
  return { token: String(res.rows[0].token) };
}

export function scheduleDownsellsWorker(logger: Logger) {
  const everySec = Number(process.env.DOWNSELLS_INTERVAL_SEC ?? '60');
  const INTERVAL_MS = Number.isFinite(everySec) && everySec >= 10 ? everySec * 1000 : 60_000;

  async function tick() {
    try {
      const pendings = await findPendingToSend(40);
      if (pendings.length === 0) return;

      for (const item of pendings) {
        try {
          const ds = await getDownsell(item.downsell_id, item.bot_slug);
          if (!ds || !ds.is_active) {
            await markQueueError(item.id, 'downsell_inativo');
            continue;
          }
          const { token } = await getBotTokenBySlug(item.bot_slug);
          const chatId = item.telegram_id;

          // Envia até 2 mídias
          const medias: Array<{ url: string; type: 'photo' | 'video' | 'audio' }> = [];
          if (ds.media1_url && ds.media1_type) medias.push({ url: ds.media1_url, type: ds.media1_type });
          if (ds.media2_url && ds.media2_type) medias.push({ url: ds.media2_url, type: ds.media2_type });

          for (let idx = 0; idx < medias.length; idx++) {
            const m = medias[idx];
            await telegramMediaCache.sendCached({
              token,
              bot_slug: item.bot_slug,
              chat_id: chatId,
              item: {
                key: `ds:${ds.id}:${idx + 1}`,
                type: m.type,
                source_url: m.url,
                caption: null,
                parse_mode: null,
              },
            });
          }

          // Texto + botão (callback gera PIX do downsell)
          const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(ds.price_cents / 100);
          const text =
            (ds.message_text ? ds.message_text + '\n\n' : '') +
            `Oferta especial: *${ds.title}* por *${brl}*`;

          await telegramMediaCache.callTelegram('sendMessage', token, {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: `Gerar PIX – ${brl}`, callback_data: `ds_pix:${ds.id}` }]],
            },
          });

          await markQueueSent(item.id);
          logger.info({ bot_slug: item.bot_slug, qid: item.id, ds: ds.id, tg: chatId }, '[DOWNSELL][SEND] ok');
        } catch (err) {
          logger.warn({ err, qid: item.id, bot_slug: item.bot_slug }, '[DOWNSELL][SEND] erro');
          await markQueueError(item.id, err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      logger.error({ err }, '[DOWNSELL][WORKER] tick failure');
    }
  }

  // Primeiro tick após 10s, depois a cada INTERVAL_MS
  setTimeout(tick, 10_000);
  setInterval(tick, INTERVAL_MS);

  logger.info({ interval_ms: INTERVAL_MS }, '[DOWNSELL][WORKER] agendado');
}


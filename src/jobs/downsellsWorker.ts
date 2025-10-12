import { pool } from '../db/pool.js';
import { getDownsell, findPendingToSend, markQueueSent, markQueueError, listVariants, countSentTodayForUser } from '../db/downsells.js';
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

          // 1) Respeita janela de horário (se habilitada)
          const tz = ds.window_tz || 'America/Recife';
          if (ds.window_enabled) {
            const hour = Number(new Intl.DateTimeFormat('en-US',{hour:'numeric',hour12:false,timeZone:tz}).format(new Date()));
            const start = ds.window_start_hour ?? 0;
            const end = ds.window_end_hour ?? 23;
            const inWindow = start <= end ? (hour >= start && hour <= end) : (hour >= start || hour <= end);
            if (!inWindow) {
              await markQueueError(item.id, 'outside_window');
              logger.info({ ds: ds.id, hour, start, end, tz }, '[DOWNSELL][WINDOW] fora da janela');
              continue;
            }
          }

          // 2) Limite diário por usuário (global por bot)
          if (ds.daily_cap_per_user > 0) {
            const sentToday = await countSentTodayForUser(item.bot_slug, item.telegram_id, tz);
            if (sentToday >= ds.daily_cap_per_user) {
              await markQueueError(item.id, 'daily_cap_reached');
              logger.info({ ds: ds.id, tg: item.telegram_id, cap: ds.daily_cap_per_user }, '[DOWNSELL][CAP] atingido');
              continue;
            }
          }

          // 3) A/B simples
          let eff = { ...ds }; // effective payload
          if (ds.ab_enabled) {
            const vars = await listVariants(ds.id);
            const A = vars.find(v=>v.key==='A');
            const B = vars.find(v=>v.key==='B');
            const wA = A?.weight ?? 50, wB = B?.weight ?? 50;
            // bucket determinístico por usuário
            const bucket = Math.abs(Number(String(item.telegram_id).split('').reduce((a,c)=>a + c.charCodeAt(0), 0))) % (wA + wB || 1);
            const pick = (bucket < wA) ? A : B;

            if (pick) {
              eff.title = pick.title ?? eff.title;
              eff.price_cents = pick.price_cents ?? eff.price_cents;
              eff.message_text = pick.message_text ?? eff.message_text;
              eff.media1_url = pick.media1_url ?? eff.media1_url;
              eff.media1_type = (pick.media1_type as any) ?? eff.media1_type;
              eff.media2_url = pick.media2_url ?? eff.media2_url;
              eff.media2_type = (pick.media2_type as any) ?? eff.media2_type;
            }
          }

          const { token } = await getBotTokenBySlug(item.bot_slug);
          const chatId = item.telegram_id;

          // Envia até 2 mídias
          const medias: Array<{ url: string; type: 'photo' | 'video' | 'audio' }> = [];
          if (eff.media1_url && eff.media1_type) medias.push({ url: eff.media1_url, type: eff.media1_type });
          if (eff.media2_url && eff.media2_type) medias.push({ url: eff.media2_url, type: eff.media2_type });

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
          const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(eff.price_cents / 100);
          const text =
            (eff.message_text ? eff.message_text + '\n\n' : '') +
            `Oferta especial: *${eff.title}* por *${brl}*`;

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


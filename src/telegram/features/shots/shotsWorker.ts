import type { PoolClient } from 'pg';
import type { Bot } from 'grammy';
import { getPool } from '../../db/pool';
import { logger } from '../../../logger.js';
import { sendWithMedia, type SendableShot, type ChatId } from './utilSend';
import type { MyContext } from '../../grammYContext.js';

const MAX_BATCH = 30;
const MAX_ATTEMPTS = 5;

export interface ShotsQueueJob {
  id: number;
  bot_slug: string;
  shot_id: number;
  telegram_id: ChatId;
  deliver_at: Date;
  status: string;
  attempt_count: number;
  last_error: string | null;
  sent_message_id: string | null;
}

interface ShotRow extends SendableShot {
  id: number;
  status: string;
}

function mapQueueRow(row: any): ShotsQueueJob {
  const telegramRaw = row.telegram_id;
  let telegramId: ChatId;
  if (typeof telegramRaw === 'bigint') {
    telegramId = telegramRaw.toString();
  } else if (typeof telegramRaw === 'number') {
    telegramId = telegramRaw;
  } else if (typeof telegramRaw === 'string') {
    telegramId = telegramRaw.trim();
  } else {
    telegramId = String(telegramRaw);
  }

  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    shot_id: Number(row.shot_id),
    telegram_id: telegramId,
    deliver_at: row.deliver_at instanceof Date ? row.deliver_at : new Date(row.deliver_at),
    status: String(row.status),
    attempt_count: Number(row.attempt_count ?? 0),
    last_error: row.last_error ?? null,
    sent_message_id: row.sent_message_id ?? null,
  };
}

export async function pickDueShots(client: PoolClient): Promise<ShotsQueueJob[]> {
  const { rows } = await client.query(
    `SELECT q.*
       FROM public.shots_queue q
      WHERE q.status = 'scheduled' AND q.deliver_at <= NOW()
      ORDER BY q.deliver_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${MAX_BATCH}`
  );

  return rows.map(mapQueueRow);
}

export async function startShotsWorker(
  getBotBySlug: (slug: string) => Bot<MyContext> | undefined
): Promise<NodeJS.Timeout> {
  const pool = await getPool();

  const tick = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const due = await pickDueShots(client);
      if (due.length === 0) {
        await client.query('COMMIT');
        return;
      }

      for (const job of due) {
        try {
          const { rows } = await client.query<ShotRow>(
            `SELECT * FROM public.shots WHERE id = $1`,
            [job.shot_id]
          );
          const shot = rows[0];

          if (!shot || shot.status !== 'scheduled') {
            await client.query(
              `UPDATE public.shots_queue SET status = 'skipped', updated_at = NOW() WHERE id = $1`,
              [job.id]
            );
            continue;
          }

          const bot = getBotBySlug(job.bot_slug);
          if (!bot) {
            throw new Error(`[SHOT] Bot não encontrado para slug ${job.bot_slug}`);
          }

          const sent = await sendWithMedia(bot, job.telegram_id, shot);

          await client.query(
            `UPDATE public.shots_queue
                SET status = 'sent', sent_message_id = $1, updated_at = NOW()
              WHERE id = $2`,
            [sent?.message_id ?? null, job.id]
          );

          await client.query(
            `INSERT INTO public.shots_sent (shot_id, bot_slug, telegram_id, message_id, status)
             VALUES ($1, $2, $3, $4, 'sent')`,
            [job.shot_id, job.bot_slug, job.telegram_id, sent?.message_id ?? null]
          );
        } catch (err) {
          const attempts = job.attempt_count + 1;
          const backoffSec = Math.min(900, Math.pow(2, attempts) * 15);
          const nextDeliver = new Date(Date.now() + backoffSec * 1000);
          const message = err instanceof Error ? err.message : String(err ?? 'unknown error');

          await client.query(
            `UPDATE public.shots_queue
               SET attempt_count = $1,
                   last_error = $2,
                   deliver_at = $3,
                   status = CASE WHEN $1 >= $4 THEN 'error' ELSE 'scheduled' END,
                   updated_at = NOW()
             WHERE id = $5`,
            [attempts, message, nextDeliver, MAX_ATTEMPTS, job.id]
          );

          logger.error({ err, jobId: job.id, shotId: job.shot_id }, '[SHOTS][WORKER] failed to process job');
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ err: e }, '[SHOTS][WORKER] tick failed');
    } finally {
      client.release();
    }
  };

  void tick().catch((err) => {
    logger.error({ err }, '[SHOTS][WORKER] initial tick failed');
  });

  const interval = setInterval(() => {
    void tick().catch((err) => {
      logger.error({ err }, '[SHOTS][WORKER] tick execution error');
    });
  }, 3000);

  return interval;
}

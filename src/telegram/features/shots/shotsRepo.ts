import { PoolClient } from 'pg';
import { logger } from '../../../logger.js';
import { getPool } from '../../db/pool.js';

export type Audience = 'started' | 'pix';
export type MediaType = 'text' | 'photo' | 'video' | 'audio' | 'animation' | 'document';

export interface NewShot {
  bot_slug: string;
  audience: Audience;
  media_type: MediaType;
  message_text?: string;
  media_url?: string;
  parse_mode?: string;
  deliver_at: Date; // com timezone
}

export async function createShotAndExpandQueue(input: NewShot): Promise<{ shotId: number; queued: number }> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: shotRows } = await client.query(
      `INSERT INTO public.shots (bot_slug, audience, media_type, message_text, media_url, parse_mode, deliver_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        input.bot_slug,
        input.audience,
        input.media_type,
        input.message_text ?? null,
        input.media_url ?? null,
        input.parse_mode ?? 'HTML',
        input.deliver_at,
      ]
    );
    const shotId = shotRows[0].id as number;

    // Seleção de público (via funnel_events real)
    // started => event='start'
    // pix     => event IN ('pix_created','purchase')
    const audienceSql = input.audience === 'started'
      ? `
        SELECT DISTINCT fe.tg_user_id AS telegram_id
          FROM public.funnel_events fe
          JOIN public.bots b ON b.id = fe.bot_id
         WHERE b.slug = $1
           AND fe.event = 'start'
           AND fe.tg_user_id IS NOT NULL
      `
      : `
        SELECT DISTINCT fe.tg_user_id AS telegram_id
          FROM public.funnel_events fe
          JOIN public.bots b ON b.id = fe.bot_id
         WHERE b.slug = $1
           AND fe.event IN ('pix_created','purchase')
           AND fe.tg_user_id IS NOT NULL
      `;

    const { rows: tgRows } = await client.query(audienceSql, [input.bot_slug]);
    logger.info({ bot_slug: input.bot_slug, audience: input.audience, total: tgRows.length }, '[SHOTS] audience expanded');

    // === Enfileira destinatários na shots_queue (colunas explícitas, sem bot_slug) ===
    // Usa índice único (shot_id, telegram_id) + ON CONFLICT DO NOTHING
    // e chunking para audiências grandes.
    const telegramIds: (number | string)[] =
      (tgRows ?? []).map((r: any) => r.telegram_id).filter(Boolean);

    let queued = 0;
    if (telegramIds.length > 0) {
      const CHUNK = 1000;
      // deliver_at: honra input.deliver_at (já gravado no cabeçalho do shot)
      const deliverAt = input.deliver_at ?? new Date();
      for (let i = 0; i < telegramIds.length; i += CHUNK) {
        const chunk = telegramIds.slice(i, i + CHUNK);
        const valuesSql = chunk
          .map((_, idx) => `($1, $${idx + 2}, $${chunk.length + 2}, 'scheduled')`)
          .join(', ');
        const params: any[] = [shotId, ...chunk, deliverAt];
        await client.query(
          `
            INSERT INTO public.shots_queue
              (shot_id, telegram_id, deliver_at, status)
            VALUES
              ${valuesSql}
            ON CONFLICT DO NOTHING
          `,
          params
        );
        queued += chunk.length;
      }
    }

    await client.query('COMMIT');
    return { shotId, queued };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createShotAndQueue(input: NewShot) {
  return createShotAndExpandQueue(input);
}

export async function listShots(bot_slug?: string) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM public.shots_queue q WHERE q.shot_id=s.id) AS total_in_queue,
            (SELECT COUNT(*) FROM public.shots_queue q WHERE q.shot_id=s.id AND q.status='sent') AS sent_count
     FROM public.shots s
     ${bot_slug ? 'WHERE s.bot_slug = $1' : ''}
     ORDER BY s.created_at DESC
     ${bot_slug ? '' : ''}`,
    bot_slug ? [bot_slug] : []
  );
  return rows;
}

export async function cancelShot(shotId: number) {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 1) Marca o shot como cancelado (mantém histórico no cabeçalho)
    await client.query(
      `UPDATE public.shots SET status='canceled', updated_at=NOW() WHERE id=$1`,
      [shotId]
    );
    // Remover da fila apenas o que ainda não foi processado
    await client.query(
      `DELETE FROM public.shots_queue WHERE shot_id=$1 AND status='scheduled'`,
      [shotId]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

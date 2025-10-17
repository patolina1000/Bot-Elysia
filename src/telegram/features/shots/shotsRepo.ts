import { PoolClient } from 'pg';
import { getPool } from '../../db/pool';

export type Audience = 'started' | 'pix';
export type MediaType = 'text' | 'photo' | 'video' | 'audio' | 'animation';

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
      [input.bot_slug, input.audience, input.media_type, input.message_text ?? null, input.media_url ?? null, input.parse_mode ?? 'HTML', input.deliver_at]
    );
    const shotId = shotRows[0].id as number;

    // Seleção de público (via funnel_events, compatível com schema atual)
    // started => event = 'bot_start'
    // pix     => event IN ('pix_created','purchase')
    //
    // Obs.: funnel_events não tem bot_slug; filtramos por bot_id
    // usando a tabela bots (slug -> id). Os IDs dos usuários
    // estão em tg_user_id.
    const audienceSql =
      input.audience === 'started'
        ? `
          SELECT DISTINCT fe.tg_user_id AS telegram_id
            FROM public.funnel_events fe
           WHERE fe.bot_id IN (SELECT id FROM public.bots WHERE slug = $1)
             AND fe.event = 'bot_start'
             AND fe.tg_user_id IS NOT NULL
        `
        : `
          SELECT DISTINCT fe.tg_user_id AS telegram_id
            FROM public.funnel_events fe
           WHERE fe.bot_id IN (SELECT id FROM public.bots WHERE slug = $1)
             AND fe.event IN ('pix_created','purchase')
             AND fe.tg_user_id IS NOT NULL
        `;

    const { rows: tgRows } = await client.query(audienceSql, [input.bot_slug]);

    // expandir fila
    let queued = 0;
    if (tgRows.length > 0) {
      const values: string[] = [];
      const params: any[] = [];
      let p = 1;
      for (const r of tgRows) {
        values.push(`($${p++}, $${p++}, $${p++}, 'scheduled', $${p++})`);
        params.push(shotId, input.bot_slug, r.telegram_id, input.deliver_at);
      }
      await client.query(
        `INSERT INTO public.shots_queue (shot_id, bot_slug, telegram_id, status, deliver_at)
         VALUES ${values.join(',')}
         ON CONFLICT (shot_id, telegram_id) DO NOTHING`,
        params
      );
      queued = tgRows.length;
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
    // 2) Remove da fila somente itens ainda não processados, evitando depender de ENUM/CHECK 'canceled'
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

import { getPool } from '../../telegram/db/pool.js';

// (mantém os tipos/funcs já adicionados no Patch 14)
export type ShotsQueueGlobalStats = {
  scheduled: number;
  sending: number;
  sent: number;
  skipped: number;
  error: number;
  total: number;
  next_due: string | null; // ISO
};

export type ShotsQueueBreakdownByShot = Array<{
  shot_id: number;
  scheduled: number;
  sending: number;
  sent: number;
  skipped: number;
  error: number;
  total: number;
}>;

export type TopErrors = Array<{
  last_error: string;
  count: number;
}>;

export type ShotWithCounts = {
  id: number;
  bot_slug: string;
  audience: string;
  media_type: string;
  message_text: string | null;
  media_url: string | null;
  parse_mode: string | null;
  status: string | null;
  deliver_at: string | null;
  scheduled: number;
  sending: number;
  sent: number;
  skipped: number;
  error: number;
  total: number;
};

export async function getShotsQueueGlobalStats(): Promise<ShotsQueueGlobalStats> {
  const pool = await getPool();
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='scheduled') AS scheduled,
      COUNT(*) FILTER (WHERE status='sending')   AS sending,
      COUNT(*) FILTER (WHERE status='sent')      AS sent,
      COUNT(*) FILTER (WHERE status='skipped')   AS skipped,
      COUNT(*) FILTER (WHERE status='error')     AS error,
      COUNT(*)                                    AS total,
      TO_CHAR(MIN(CASE WHEN status='scheduled' THEN deliver_at END) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS next_due
    FROM public.shots_queue;
  `);
  const r = rows[0] || {};
  return {
    scheduled: Number(r.scheduled || 0),
    sending:   Number(r.sending   || 0),
    sent:      Number(r.sent      || 0),
    skipped:   Number(r.skipped   || 0),
    error:     Number(r.error     || 0),
    total:     Number(r.total     || 0),
    next_due:  r.next_due ?? null,
  };
}

export async function getShotsQueueBreakdownByShot(): Promise<ShotsQueueBreakdownByShot> {
  const pool = await getPool();
  const { rows } = await pool.query(`
    SELECT
      shot_id,
      COUNT(*) FILTER (WHERE status='scheduled') AS scheduled,
      COUNT(*) FILTER (WHERE status='sending')   AS sending,
      COUNT(*) FILTER (WHERE status='sent')      AS sent,
      COUNT(*) FILTER (WHERE status='skipped')   AS skipped,
      COUNT(*) FILTER (WHERE status='error')     AS error,
      COUNT(*)                                    AS total
    FROM public.shots_queue
    GROUP BY shot_id
    ORDER BY shot_id DESC;
  `);
  return rows.map((r) => ({
    shot_id:   Number(r.shot_id),
    scheduled: Number(r.scheduled || 0),
    sending:   Number(r.sending   || 0),
    sent:      Number(r.sent      || 0),
    skipped:   Number(r.skipped   || 0),
    error:     Number(r.error     || 0),
    total:     Number(r.total     || 0),
  }));
}

export async function getTopErrors(limit = 10): Promise<TopErrors> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `
      SELECT last_error, COUNT(*) AS count
        FROM public.shots_queue
       WHERE status='error' AND last_error IS NOT NULL
       GROUP BY last_error
       ORDER BY COUNT(*) DESC, last_error ASC
       LIMIT $1
    `,
    [limit]
  );
  return rows.map((r) => ({ last_error: r.last_error, count: Number(r.count) }));
}

// === Lista shots com contagens (para o Admin) ===
export async function getShotsWithCounts(limit = 200, botSlug?: string): Promise<ShotWithCounts[]> {
  const pool = await getPool();
  const params: Array<string | number> = [];
  let where = '';

  if (botSlug) {
    params.push(botSlug);
    where = `WHERE s.bot_slug = $${params.length}`;
  }

  params.push(limit);
  const limitIdx = params.length;

  const { rows } = await pool.query(
    `
    WITH agg AS (
      SELECT shot_id,
             COUNT(*) FILTER (WHERE status='scheduled') AS scheduled,
             COUNT(*) FILTER (WHERE status='sending')   AS sending,
             COUNT(*) FILTER (WHERE status='sent')      AS sent,
             COUNT(*) FILTER (WHERE status='skipped')   AS skipped,
             COUNT(*) FILTER (WHERE status='error')     AS error,
             COUNT(*)                                    AS total
        FROM public.shots_queue
       GROUP BY shot_id
    )
    SELECT s.id,
           s.bot_slug,
           s.audience,
           s.media_type,
           s.message_text,
           s.media_url,
           s.parse_mode,
           s.status,
           s.deliver_at,
           s.created_at,
           s.updated_at,
           COALESCE(a.scheduled,0) AS scheduled,
           COALESCE(a.sending,0)   AS sending,
           COALESCE(a.sent,0)      AS sent,
           COALESCE(a.skipped,0)   AS skipped,
           COALESCE(a.error,0)     AS error,
           COALESCE(a.total,0)     AS total
      FROM public.shots s
 LEFT JOIN agg a ON a.shot_id = s.id
      ${where}
  ORDER BY s.id DESC
     LIMIT $${limitIdx}
    `,
    params
  );

  return rows.map((row) => ({
    id: Number(row.id),
    bot_slug: row.bot_slug,
    audience: row.audience,
    media_type: row.media_type,
    message_text: row.message_text ?? null,
    media_url: row.media_url ?? null,
    parse_mode: row.parse_mode ?? null,
    status: row.status ?? null,
    deliver_at: row.deliver_at ? new Date(row.deliver_at).toISOString() : null,
    scheduled: Number(row.scheduled ?? 0),
    sending: Number(row.sending ?? 0),
    sent: Number(row.sent ?? 0),
    skipped: Number(row.skipped ?? 0),
    error: Number(row.error ?? 0),
    total: Number(row.total ?? 0),
  }));
}

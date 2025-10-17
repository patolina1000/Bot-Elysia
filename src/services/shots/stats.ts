import { getPool } from '../../telegram/db/pool.js';

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

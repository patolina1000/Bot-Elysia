import { pool } from './pool.js';

export type DownsellMetricEvent = 'view' | 'click' | 'purchase' | 'pix_created';

export interface DownsellMetricInput {
  bot_slug: string;
  downsell_id: number;
  event: DownsellMetricEvent;
  telegram_id?: number;
  meta?: Record<string, any>;
}

/**
 * Registra um evento de métrica para um downsell
 * Ignora erros silenciosamente se a tabela não existir (graceful degradation)
 */
export async function trackDownsellMetric(input: DownsellMetricInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO downsell_metrics (bot_slug, downsell_id, event, telegram_id, meta)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.bot_slug,
        input.downsell_id,
        input.event,
        input.telegram_id ?? null,
        JSON.stringify(input.meta ?? {}),
      ]
    );
  } catch (error: any) {
    // Se a tabela não existe (42P01), ignora silenciosamente
    if (error?.code === '42P01') {
      return;
    }
    // Para outros erros, loga mas não quebra o fluxo
    console.warn('[downsell_metrics] Failed to track event:', error.message);
  }
}

/**
 * Busca métricas agregadas por downsell para um bot
 */
export async function getDownsellMetricsSummary(
  botSlug: string
): Promise<
  Record<
    number,
    {
      views: number;
      clicks: number;
      purchases: number;
      pix_created: number;
      conversion_rate: number; // purchases / views
      ctr: number; // clicks / views
    }
  >
> {
  try {
    const res = await pool.query(
      `SELECT 
        downsell_id,
        COUNT(*) FILTER (WHERE event = 'view') AS views,
        COUNT(*) FILTER (WHERE event = 'click') AS clicks,
        COUNT(*) FILTER (WHERE event = 'purchase') AS purchases,
        COUNT(*) FILTER (WHERE event = 'pix_created') AS pix_created
       FROM downsell_metrics
       WHERE bot_slug = $1
       GROUP BY downsell_id`,
      [botSlug]
    );

    const summary: Record<number, any> = {};
    for (const row of res.rows) {
      const views = Number(row.views ?? 0);
      const clicks = Number(row.clicks ?? 0);
      const purchases = Number(row.purchases ?? 0);
      const pix_created = Number(row.pix_created ?? 0);

      summary[Number(row.downsell_id)] = {
        views,
        clicks,
        purchases,
        pix_created,
        conversion_rate: views > 0 ? purchases / views : 0,
        ctr: views > 0 ? clicks / views : 0,
      };
    }

    return summary;
  } catch (error: any) {
    // Se a tabela não existe, retorna vazio
    if (error?.code === '42P01') {
      return {};
    }
    throw error;
  }
}

/**
 * Busca métricas detalhadas com filtros opcionais
 */
export async function getDownsellMetricsDetailed(params: {
  bot_slug: string;
  downsell_id?: number;
  event?: DownsellMetricEvent;
  telegram_id?: number;
  limit?: number;
  offset?: number;
}): Promise<
  Array<{
    id: number;
    bot_slug: string;
    downsell_id: number;
    event: DownsellMetricEvent;
    telegram_id: number | null;
    meta: Record<string, any>;
    created_at: string;
  }>
> {
  try {
    const conditions: string[] = ['bot_slug = $1'];
    const values: any[] = [params.bot_slug];
    let paramIdx = 2;

    if (params.downsell_id !== undefined) {
      conditions.push(`downsell_id = $${paramIdx}`);
      values.push(params.downsell_id);
      paramIdx++;
    }

    if (params.event) {
      conditions.push(`event = $${paramIdx}`);
      values.push(params.event);
      paramIdx++;
    }

    if (params.telegram_id !== undefined) {
      conditions.push(`telegram_id = $${paramIdx}`);
      values.push(params.telegram_id);
      paramIdx++;
    }

    const limit = Math.min(params.limit ?? 100, 1000);
    const offset = params.offset ?? 0;

    const sql = `
      SELECT id, bot_slug, downsell_id, event, telegram_id, meta, created_at
      FROM downsell_metrics
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;

    const res = await pool.query(sql, [...values, limit, offset]);

    return res.rows.map((r) => ({
      id: Number(r.id),
      bot_slug: r.bot_slug,
      downsell_id: Number(r.downsell_id),
      event: r.event,
      telegram_id: r.telegram_id ? Number(r.telegram_id) : null,
      meta: typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  } catch (error: any) {
    if (error?.code === '42P01') {
      return [];
    }
    throw error;
  }
}

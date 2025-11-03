export const sqlSnippets = {
  // Get funnel summary counts
  summary: `
    SELECT event, COUNT(*) as count
    FROM funnel_events
    WHERE bot_id = $1
      AND occurred_at >= $2
      AND occurred_at <= $3
    GROUP BY event
    ORDER BY event
  `,

  // Timeseries by granularity (day or hour)
  timeseries: `
    SELECT
      DATE_TRUNC($4, occurred_at) as period,
      event,
      COUNT(*) as count
    FROM funnel_events
    WHERE bot_id = $1
      AND occurred_at >= $2
      AND occurred_at <= $3
    GROUP BY period, event
    ORDER BY period, event
  `,

  // Conversion by telegram users
  conversionByTelegram: `
    WITH user_funnel AS (
      SELECT DISTINCT ON (tg_user_id, event)
        tg_user_id,
        event
      FROM funnel_events
      WHERE bot_id = $1
        AND occurred_at >= $2
        AND occurred_at <= $3
        AND tg_user_id IS NOT NULL
    )
    SELECT
      event,
      COUNT(DISTINCT tg_user_id) as unique_users
    FROM user_funnel
    GROUP BY event
    ORDER BY event
  `,

  // Conversion by transaction
  conversionByTransaction: `
    SELECT 
      event,
      COUNT(DISTINCT COALESCE(transaction_id, event_id)) as unique_transactions
    FROM funnel_events
    WHERE bot_id = $1
      AND occurred_at >= $2
      AND occurred_at <= $3
    GROUP BY event
    ORDER BY event
  `,

  // Breakdown by dimension (utm_source, utm_campaign, etc)
  breakdown: `
    SELECT 
      meta->>$4 as dimension_value,
      event,
      COUNT(*) as count
    FROM funnel_events
    WHERE bot_id = $1
      AND occurred_at >= $2
      AND occurred_at <= $3
      AND meta->>$4 IS NOT NULL
    GROUP BY dimension_value, event
    ORDER BY dimension_value, event
  `,

  // Get event by event_id with logs
  debugEvent: `
    SELECT 
      fe.*,
      (
        SELECT json_agg(al.*)
        FROM app_logs al
        WHERE al.meta->>'event_id' = fe.event_id
        ORDER BY al.created_at
      ) as logs
    FROM funnel_events fe
    WHERE fe.event_id = $1
  `,
};

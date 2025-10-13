BEGIN;

CREATE OR REPLACE VIEW public.admin_downsell_metrics AS
SELECT
  COALESCE(meta->>'bot_slug','') AS bot_slug,
  SUM(CASE WHEN event = 'downs_scheduled' THEN 1 ELSE 0 END) AS scheduled,
  SUM(CASE WHEN event = 'downs_sent'      THEN 1 ELSE 0 END) AS sent,
  SUM(CASE WHEN event = 'downs_canceled'  THEN 1 ELSE 0 END) AS canceled,
  SUM(CASE WHEN event = 'downs_error'     THEN 1 ELSE 0 END) AS error,
  SUM(CASE WHEN event = 'pix_created'     THEN 1 ELSE 0 END) AS pix,
  SUM(CASE WHEN event = 'purchase'        THEN 1 ELSE 0 END) AS purchased,
  MAX(occurred_at) AS last_seen
FROM public.funnel_events
WHERE occurred_at >= NOW() - INTERVAL '7 days'
GROUP BY 1;

COMMIT;

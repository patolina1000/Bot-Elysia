import { Router, Request, Response } from 'express';
import { pool } from '../db/pool.js';
import { sqlSnippets } from './SqlSnippets.js';
import { z } from 'zod';

export const funnelApiRouter = Router();

const dateRangeSchema = z.object({
  bot_id: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

const timeseriesSchema = dateRangeSchema.extend({
  granularity: z.enum(['day', 'hour']).default('day'),
});

const conversionSchema = dateRangeSchema.extend({
  by: z.enum(['telegram', 'transaction']).default('telegram'),
});

const breakdownSchema = dateRangeSchema.extend({
  dimension: z.string(),
});

// GET /analytics/funnel?bot_id&from&to
funnelApiRouter.get('/funnel', async (req: Request, res: Response): Promise<void> => {
  try {
    const params = dateRangeSchema.parse(req.query);

    const result = await pool.query(sqlSnippets.summary, [
      params.bot_id,
      params.from,
      params.to,
    ]);

    const summary: Record<string, number> = {};
    for (const row of result.rows) {
      summary[row.event] = parseInt(row.count, 10);
    }

    res.json(summary);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid parameters', details: err.errors });
      return;
    }
    req.log?.error({ err }, 'Error getting funnel summary');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /analytics/funnel/by-day?bot_id&from&to&granularity=day|hour
funnelApiRouter.get('/funnel/by-day', async (req: Request, res: Response): Promise<void> => {
  try {
    const params = timeseriesSchema.parse(req.query);

    const result = await pool.query(sqlSnippets.timeseries, [
      params.bot_id,
      params.from,
      params.to,
      params.granularity,
    ]);

    res.json(result.rows);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid parameters', details: err.errors });
      return;
    }
    req.log?.error({ err }, 'Error getting funnel timeseries');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /analytics/conversion?bot_id&from&to&by=telegram|transaction
funnelApiRouter.get('/conversion', async (req: Request, res: Response): Promise<void> => {
  try {
    const params = conversionSchema.parse(req.query);

    const sql =
      params.by === 'telegram'
        ? sqlSnippets.conversionByTelegram
        : sqlSnippets.conversionByTransaction;

    const result = await pool.query(sql, [params.bot_id, params.from, params.to]);

    res.json(result.rows);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid parameters', details: err.errors });
      return;
    }
    req.log?.error({ err }, 'Error getting conversion data');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /analytics/breakdown?bot_id&from&to&dimension=utm_source|utm_campaign|bot_id
funnelApiRouter.get('/breakdown', async (req: Request, res: Response): Promise<void> => {
  try {
    const params = breakdownSchema.parse(req.query);

    const result = await pool.query(sqlSnippets.breakdown, [
      params.bot_id,
      params.from,
      params.to,
      params.dimension,
    ]);

    res.json(result.rows);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid parameters', details: err.errors });
      return;
    }
    req.log?.error({ err }, 'Error getting breakdown data');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /analytics/debug/:event_id
funnelApiRouter.get('/debug/:event_id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { event_id } = req.params;

    const result = await pool.query(sqlSnippets.debugEvent, [event_id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    req.log?.error({ err }, 'Error getting debug data');
    res.status(500).json({ error: 'Internal server error' });
  }
});

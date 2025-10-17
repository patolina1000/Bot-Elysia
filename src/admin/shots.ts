import type { Request, Response } from 'express';
import {
  createShotAndExpandQueue,
  listShots,
  cancelShot,
  type NewShot,
} from '../telegram/features/shots/shotsRepo.js';

export async function postCreateShot(req: Request, res: Response) {
  try {
    const { bot_slug, audience, send_at, media_type, message_text, media_url, parse_mode } = req.body || {};
    if (!bot_slug || !audience || !media_type) {
      return res.status(400).json({ error: 'bot_slug, audience e media_type são obrigatórios' });
    }

    const deliver_at = send_at === 'now' ? new Date(Date.now() + 5000) : new Date(send_at);
    if (Number.isNaN(deliver_at.getTime())) {
      return res.status(400).json({ error: 'send_at inválido' });
    }

    const shot: NewShot = {
      bot_slug,
      audience,
      media_type,
      message_text,
      media_url,
      parse_mode: parse_mode || 'HTML',
      deliver_at,
    };

    const { shotId, queued } = await createShotAndExpandQueue(shot);
    return res.json({ ok: true, id: shotId, queued });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'internal' });
  }
}

export async function getListShots(req: Request, res: Response) {
  try {
    const { bot } = req.query as any;
    const rows = await listShots(bot);
    return res.json({ items: rows });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'internal' });
  }
}

export async function postCancelShot(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    await cancelShot(id);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'internal' });
  }
}

import type { Request, Response } from 'express';
import {
  createShotAndQueue,
  cancelShot,
  type NewShot,
} from '../telegram/features/shots/shotsRepo.js';
import { getShotsWithCounts } from '../services/shots/stats.js';

function normalizeAudience(value: unknown): NewShot['audience'] | null {
  const audience = (value ?? '').toString().trim();
  if (audience === 'pix') {
    return 'pix';
  }
  if (!audience || audience === 'started') {
    return 'started';
  }
  return null;
}

function normalizeMediaType(value: unknown): NewShot['media_type'] {
  const media = (value ?? '').toString().trim();
  const allowed: NewShot['media_type'][] = ['text', 'photo', 'video', 'audio', 'animation', 'document'];
  if (allowed.includes(media as NewShot['media_type'])) {
    return media as NewShot['media_type'];
  }
  return 'text';
}

export async function postCreateShot(req: Request, res: Response) {
  try {
    const {
      bot_slug,
      audience,
      send_at,
      scheduled_at,
      media_type,
      message_text,
      media_url,
      parse_mode,
      deliver_at: deliverAtBody,
    } = req.body || {};

    const botSlug = (bot_slug ?? '').toString().trim();
    const audienceValue = normalizeAudience(audience);
    const mediaType = normalizeMediaType(media_type);
    const messageText =
      typeof message_text === 'string'
        ? message_text
        : message_text != null
          ? String(message_text)
          : undefined;
    const mediaUrl =
      typeof media_url === 'string'
        ? media_url
        : media_url != null
          ? String(media_url)
          : undefined;
    const parseModeValue = (parse_mode ?? 'HTML').toString().trim() || 'HTML';

    if (!botSlug || !audienceValue || !mediaType) {
      return res.status(400).json({ error: 'bot_slug, audience e media_type são obrigatórios' });
    }

    if (mediaType !== 'text' && !(mediaUrl ?? '').toString().trim()) {
      return res.status(400).json({ error: 'media_url é obrigatório para media_type diferente de text' });
    }

    const sendAtRaw = (send_at ?? '').toString();
    const scheduledRaw = scheduled_at ?? deliverAtBody ?? null;

    let deliver_at: Date;

    if (!sendAtRaw || sendAtRaw === 'now') {
      deliver_at = new Date();
    } else if (sendAtRaw === 'schedule') {
      const scheduledDate = scheduledRaw ? new Date(scheduledRaw) : null;
      deliver_at = scheduledDate && !Number.isNaN(scheduledDate.getTime()) ? scheduledDate : new Date();
    } else {
      const parsed = new Date(sendAtRaw);
      deliver_at = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    }

    if (Number.isNaN(deliver_at.getTime())) {
      return res.status(400).json({ error: 'send_at inválido' });
    }

    const shot: NewShot = {
      bot_slug: botSlug,
      audience: audienceValue,
      media_type: mediaType,
      message_text: messageText?.trim() || undefined,
      media_url: mediaUrl?.trim() || undefined,
      parse_mode: parseModeValue,
      deliver_at,
    };

    const { shotId, queued } = await createShotAndQueue(shot);

    return res.json({
      ok: true,
      data: {
        id: shotId,
        shotId,
        queued,
        deliver_at: deliver_at.toISOString(),
      },
      id: shotId,
      queued,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'internal' });
  }
}

export async function getListShots(req: Request, res: Response) {
  try {
    const botSlugRaw = (req.query?.bot || '').toString().trim();
    const limitRaw = (req.query?.limit || '').toString().trim();
    const limitValue = Number(limitRaw);
    const limit = Number.isFinite(limitValue) ? Math.min(Math.max(1, limitValue), 500) : 200;

    const rows = await getShotsWithCounts(limit, botSlugRaw || undefined);
    return res.json({ ok: true, data: rows, items: rows });
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

import type { Pool } from 'pg';
import { pool } from '../db/pool.js';
import { getEncryptionKey } from '../utils/crypto.js';

export type TelegramMediaType = 'photo' | 'video' | 'audio' | 'document' | 'voice';

export interface TelegramMediaRegistryItem {
  key: string;
  type: TelegramMediaType;
  source_url?: string | null;
  caption?: string | null;
  parse_mode?: string | null;
  file_id?: string | null;
  file_unique_id?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export interface BotMediaCacheConfig {
  slug: string;
  token: string;
  warmup_chat_id: string | null;
  media_registry: TelegramMediaRegistryItem[];
}

type TelegramApiResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: unknown;
};

type LoggerLike = {
  info?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
};

interface UpsertCacheParams {
  bot_slug: string;
  media_key: string;
  media_type: TelegramMediaType;
  source_url?: string | null;
  file_id?: string | null;
  file_unique_id?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  status?: string;
  meta?: Record<string, unknown> | null;
}

interface WarmOneParams {
  bot_slug: string;
  token: string;
  warmup_chat_id: string;
  item: TelegramMediaRegistryItem;
}

interface SendCachedParams {
  token: string;
  bot_slug: string;
  chat_id: number | string;
  item: TelegramMediaRegistryItem;
}

const TELEGRAM_METHOD_MAP: Record<
  TelegramMediaType,
  { method: string; field: string }
> = {
  photo: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  audio: { method: 'sendAudio', field: 'audio' },
  document: { method: 'sendDocument', field: 'document' },
  voice: { method: 'sendVoice', field: 'voice' },
};

function extractFileInfo(
  message: any,
  type: TelegramMediaType
): {
  file_id?: string;
  file_unique_id?: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
} {
  if (!message || typeof message !== 'object') {
    return {};
  }

  if (type === 'photo' && Array.isArray(message.photo) && message.photo.length > 0) {
    const best = message.photo[message.photo.length - 1];
    return {
      file_id: best?.file_id,
      file_unique_id: best?.file_unique_id,
      width: best?.width ?? null,
      height: best?.height ?? null,
      duration: null,
    };
  }

  if (type === 'video' && message.video) {
    return {
      file_id: message.video.file_id,
      file_unique_id: message.video.file_unique_id,
      width: message.video.width ?? null,
      height: message.video.height ?? null,
      duration: message.video.duration ?? null,
    };
  }

  if (type === 'audio' && message.audio) {
    return {
      file_id: message.audio.file_id,
      file_unique_id: message.audio.file_unique_id,
      width: null,
      height: null,
      duration: message.audio.duration ?? null,
    };
  }

  if (type === 'document' && message.document) {
    return {
      file_id: message.document.file_id,
      file_unique_id: message.document.file_unique_id,
      width: null,
      height: null,
      duration: null,
    };
  }

  if (type === 'voice' && message.voice) {
    return {
      file_id: message.voice.file_id,
      file_unique_id: message.voice.file_unique_id,
      width: null,
      height: null,
      duration: message.voice.duration ?? null,
    };
  }

  return {};
}

export class TelegramMediaCache {
  private pg: Pool;
  private listBotsFn: () => Promise<BotMediaCacheConfig[]>;

  constructor({ pgPool, listBots }: { pgPool: Pool; listBots: () => Promise<BotMediaCacheConfig[]> }) {
    this.pg = pgPool;
    this.listBotsFn = listBots;
  }

  private async tg<T = unknown>(
    method: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<TelegramApiResponse<T>> {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    let data: TelegramApiResponse<T>;
    try {
      data = (await response.json()) as TelegramApiResponse<T>;
    } catch (err) {
      throw new Error(`Invalid Telegram response for ${method}: ${(err as Error).message}`);
    }

    return data;
  }

  async upsertCache(params: UpsertCacheParams) {
    const sql = `
      INSERT INTO public.bot_media_cache
        (bot_slug, media_key, media_type, source_url, file_id, file_unique_id, width, height, duration, status, last_warmed_at, meta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11)
      ON CONFLICT (bot_slug, media_key)
      DO UPDATE SET
        media_type=EXCLUDED.media_type,
        source_url=EXCLUDED.source_url,
        file_id=EXCLUDED.file_id,
        file_unique_id=EXCLUDED.file_unique_id,
        width=EXCLUDED.width,
        height=EXCLUDED.height,
        duration=EXCLUDED.duration,
        status=EXCLUDED.status,
        last_warmed_at=NOW(),
        meta=EXCLUDED.meta
      RETURNING *;`;

    const values = [
      params.bot_slug,
      params.media_key,
      params.media_type,
      params.source_url ?? null,
      params.file_id ?? null,
      params.file_unique_id ?? null,
      params.width ?? null,
      params.height ?? null,
      params.duration ?? null,
      params.status ?? 'warm',
      params.meta ?? {},
    ];

    const { rows } = await this.pg.query(sql, values);
    return rows[0];
  }

  async getCache(bot_slug: string, media_key: string) {
    const { rows } = await this.pg.query(
      'SELECT * FROM public.bot_media_cache WHERE bot_slug=$1 AND media_key=$2',
      [bot_slug, media_key]
    );
    return rows[0] ?? null;
  }

  async warmOne({ bot_slug, token, warmup_chat_id, item }: WarmOneParams) {
    if (!item.source_url) {
      throw new Error(`[warmOne] ${bot_slug}/${item.key} missing source_url`);
    }

    const mapping = TELEGRAM_METHOD_MAP[item.type];
    if (!mapping) {
      throw new Error(`Tipo de mídia não suportado: ${item.type}`);
    }

    const payload: Record<string, unknown> = {
      chat_id: warmup_chat_id,
      disable_notification: true,
      caption: item.caption ?? undefined,
      parse_mode: item.parse_mode ?? undefined,
    };
    payload[mapping.field] = item.source_url;

    if (item.type === 'video') {
      payload['supports_streaming'] = true;
    }

    const res = await this.tg(mapping.method, token, payload);
    if (!res.ok) {
      await this.upsertCache({
        bot_slug,
        media_key: item.key,
        media_type: item.type,
        source_url: item.source_url,
        status: 'error',
        meta: { error: res },
      });
      throw new Error(`[warmOne] ${bot_slug}/${item.key} erro TG: ${JSON.stringify(res)}`);
    }

    const info = extractFileInfo(res.result, item.type);
    if (!info.file_id) {
      throw new Error(`[warmOne] ${bot_slug}/${item.key} não capturou file_id`);
    }

    return this.upsertCache({
      bot_slug,
      media_key: item.key,
      media_type: item.type,
      source_url: item.source_url,
      file_id: info.file_id,
      file_unique_id: info.file_unique_id,
      width: info.width,
      height: info.height,
      duration: info.duration,
      status: 'warm',
    });
  }

  async sendCached({ token, bot_slug, chat_id, item }: SendCachedParams) {
    const mapping = TELEGRAM_METHOD_MAP[item.type];
    if (!mapping) {
      throw new Error(`Tipo de mídia não suportado: ${item.type}`);
    }

    const basePayload: Record<string, unknown> = {
      chat_id,
      caption: item.caption ?? undefined,
      parse_mode: item.parse_mode ?? undefined,
    };

    const sendBy = async (value: string) => {
      const payload = { ...basePayload, [mapping.field]: value };
      if (item.type === 'video') {
        payload['supports_streaming'] = true;
      }
      const res = await this.tg(mapping.method, token, payload);
      if (!res.ok) {
        throw new Error(res.description || 'telegram send error');
      }
      const info = extractFileInfo(res.result, item.type);
      if (info.file_id) {
        await this.upsertCache({
          bot_slug,
          media_key: item.key,
          media_type: item.type,
          source_url: item.source_url,
          file_id: info.file_id,
          file_unique_id: info.file_unique_id,
          width: info.width,
          height: info.height,
          duration: info.duration,
          status: 'warm',
        });
      }
      return res.result;
    };

    const fileIdsToTry: (string | null | undefined)[] = [
      item.file_id,
    ];

    const cache = await this.getCache(bot_slug, item.key);
    if (cache?.file_id) {
      fileIdsToTry.push(cache.file_id);
    }

    for (const candidate of fileIdsToTry) {
      if (!candidate) {
        continue;
      }
      try {
        return await sendBy(candidate);
      } catch (err) {
        // continue to next candidate
      }
    }

    if (!item.source_url) {
      throw new Error(`source_url ausente para ${bot_slug}/${item.key}`);
    }

    const bots = await this.listBotsFn();
    const bot = bots.find((b) => b.slug === bot_slug);
    if (!bot?.warmup_chat_id) {
      throw new Error(`warmup_chat_id ausente para ${bot_slug}`);
    }

    const warmed = await this.warmOne({ bot_slug, token, warmup_chat_id: bot.warmup_chat_id, item });
    if (!warmed?.file_id) {
      throw new Error(`Falha ao aquecer mídia ${bot_slug}/${item.key}`);
    }

    return await sendBy(warmed.file_id);
  }

  async warmAllForBot(bot: BotMediaCacheConfig, logger: LoggerLike = console) {
    if (!bot.warmup_chat_id) {
      return;
    }

    for (const item of bot.media_registry) {
      try {
        const cache = await this.getCache(bot.slug, item.key);
        if (cache?.file_id) {
          continue;
        }
        if (!item.source_url) {
          logger.warn?.({ slug: bot.slug, key: item.key }, '[warmup] pulando sem source_url');
          continue;
        }
        await this.warmOne({
          bot_slug: bot.slug,
          token: bot.token,
          warmup_chat_id: bot.warmup_chat_id,
          item,
        });
        logger.info?.({ slug: bot.slug, key: item.key }, '[warmup] ok');
      } catch (err) {
        logger.error?.({ slug: bot.slug, key: item.key, err: String(err) }, '[warmup] erro');
      }
    }
  }

  scheduleHourlyWarmup(logger: LoggerLike = console) {
    const run = async () => {
      const bots = await this.listBotsFn();
      for (const bot of bots) {
        try {
          await this.warmAllForBot(bot, logger);
        } catch (err) {
          logger.error?.({ slug: bot.slug, err: String(err) }, '[warmup] erro geral');
        }
      }
    };

    run().catch((err) => {
      logger.error?.({ err: String(err) }, '[warmup] inicial falhou');
    });

    setInterval(() => {
      run().catch((err) => {
        logger.error?.({ err: String(err) }, '[warmup] ciclo falhou');
      });
    }, 60 * 60 * 1000);
  }

  async findBotConfig(slug: string): Promise<BotMediaCacheConfig | undefined> {
    const bots = await this.listBotsFn();
    return bots.find((bot) => bot.slug === slug);
  }
}

export async function listBotsForMediaCache(): Promise<BotMediaCacheConfig[]> {
  const botsResult = await pool.query(
    `SELECT
       b.id,
       b.slug,
       b.enabled,
       pgp_sym_decrypt(b.token_encrypted, $1)::text AS token,
       settings.warmup_chat_id,
       tmpl.parse_mode
     FROM bots b
     LEFT JOIN public.tg_bot_settings settings ON settings.bot_slug = b.slug
     LEFT JOIN public.templates_start tmpl ON tmpl.bot_id = b.id
     WHERE b.slug IS NOT NULL`,
    [getEncryptionKey()]
  );

  const mediaResult = await pool.query(
    `SELECT
       m.id,
       m.bot_id,
       m.kind,
       m.source_url,
       m.file_id,
       m.file_unique_id,
       m.width,
       m.height,
       m.duration
     FROM media_assets m`
  );

  const mediaByBot = new Map<string, TelegramMediaRegistryItem[]>();
  for (const row of mediaResult.rows) {
    const type = row.kind as TelegramMediaType;
    if (!TELEGRAM_METHOD_MAP[type]) {
      continue;
    }
    const items = mediaByBot.get(row.bot_id) ?? [];
    items.push({
      key: row.id,
      type,
      source_url: row.source_url,
      caption: null,
      parse_mode: null,
      file_id: row.file_id,
      file_unique_id: row.file_unique_id,
      width: row.width,
      height: row.height,
      duration: row.duration,
    });
    mediaByBot.set(row.bot_id, items);
  }

  return botsResult.rows
    .filter((row) => row.enabled && row.slug && row.token)
    .map((row) => {
      const registry = mediaByBot.get(row.id) ?? [];
      const parseMode = row.parse_mode as string | null | undefined;
      return {
        slug: row.slug as string,
        token: row.token as string,
        warmup_chat_id: row.warmup_chat_id ? String(row.warmup_chat_id) : null,
        media_registry: registry.map((item) => ({
          ...item,
          parse_mode: item.parse_mode ?? parseMode ?? null,
        })),
      } satisfies BotMediaCacheConfig;
    });
}

export const telegramMediaCache = new TelegramMediaCache({
  pgPool: pool,
  listBots: listBotsForMediaCache,
});

const MAX_ENTRIES = 400;

export type TelegramSendRoute =
  | 'file_id'
  | 'url_fallback'
  | 'file_id_after_warm'
  | 'warmup_to_channel'
  | 'keepalive_ping';

export interface TelegramSendProfileMeta {
  bot_slug: string;
  chat_id: string;
  media_key?: string | null;
  route: TelegramSendRoute | string;
}

export interface TelegramSendProfileEntry {
  ts: string;
  bot_slug: string;
  chat_id: string;
  media_key: string | null;
  route: string;
  ok: boolean;
  tg_ms: number;
  gapGlobal_ms: number;
  gapChat_ms: number;
  error: string | null;
}

let lastGlobalSentAt = 0;
const lastSentByChat = new Map<string, number>();
const lastSentByBot = new Map<string, number>();
const entries: TelegramSendProfileEntry[] = [];

function pushEntry(entry: TelegramSendProfileEntry) {
  if (entries.length >= MAX_ENTRIES) {
    entries.shift();
  }
  entries.push(entry);
}

function nowMs() {
  return Date.now();
}

function hrNow() {
  return process.hrtime.bigint();
}

export async function profileSend<T>(meta: TelegramSendProfileMeta, fn: () => Promise<T>): Promise<T> {
  const startWall = nowMs();
  const gapGlobal = startWall - (lastGlobalSentAt || 0);
  const lastChatSentAt = lastSentByChat.get(meta.chat_id) || 0;
  const gapChat = startWall - lastChatSentAt;
  const startHr = hrNow();

  let ok = false;
  let error: unknown = null;
  try {
    const result = await fn();
    ok = true;
    return result;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    const endHr = hrNow();
    const tgMs = Number(endHr - startHr) / 1e6;
    const timestamp = new Date().toISOString();
    const endWall = nowMs();
    lastGlobalSentAt = endWall;
    lastSentByChat.set(meta.chat_id, endWall);

    const entry: TelegramSendProfileEntry = {
      ts: timestamp,
      bot_slug: meta.bot_slug,
      chat_id: meta.chat_id,
      media_key: meta.media_key ?? null,
      route: meta.route,
      ok,
      tg_ms: Math.round(tgMs),
      gapGlobal_ms: gapGlobal,
      gapChat_ms: gapChat,
      error: error ? String(error) : null,
    };

    pushEntry(entry);
    lastSentByBot.set(meta.bot_slug, endWall);
  }
}

export function getRecentSends(limit = 100) {
  if (limit <= 0) {
    return [] as TelegramSendProfileEntry[];
  }
  const start = Math.max(0, entries.length - limit);
  return entries.slice(start);
}

function percentile(values: number[], p: number) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * p);
  return sorted[index] ?? null;
}

export function getSendStats() {
  const byRoute = new Map<string, number[]>();
  for (const entry of entries) {
    const arr = byRoute.get(entry.route) ?? [];
    arr.push(entry.tg_ms);
    byRoute.set(entry.route, arr);
  }

  const routes: Record<string, { count: number; p50_ms: number | null; p95_ms: number | null; p99_ms: number | null }> = {};
  for (const [route, arr] of byRoute.entries()) {
    routes[route] = {
      count: arr.length,
      p50_ms: percentile(arr, 0.5),
      p95_ms: percentile(arr, 0.95),
      p99_ms: percentile(arr, 0.99),
    };
  }

  return {
    total: entries.length,
    routes,
    lastGlobalSentAt,
  };
}

export function getLastSentByBot() {
  return new Map(lastSentByBot.entries());
}


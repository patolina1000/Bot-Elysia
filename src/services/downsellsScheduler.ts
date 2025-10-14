import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { botRegistry } from './BotRegistry.js';
import { telegramMediaCache } from './TelegramMediaCache.js';
import { profileSend } from './TelegramSendProfiler.js';

type TriggerType = 'after_start' | 'after_pix';

type DownsellRow = {
  id: number;
  delay_minutes: number | null;
};

type DownsellJobRow = {
  id: number;
  bot_slug: string;
  downsell_id: number;
  telegram_id: number;
  scheduled_at: Date;
  sent_at: Date | null;
  status: string;
  attempts: number;
  last_error: string | null;
};

const serviceLogger = logger.child({ svc: 'downsellsScheduler' });
const MAX_ATTEMPTS = 10;

function parseDelayMinutes(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.min(Math.floor(numeric), 10080);
}

function mapDownsell(row: any): DownsellRow {
  return {
    id: Number(row.id),
    delay_minutes:
      row.delay_minutes === null || row.delay_minutes === undefined
        ? null
        : Number(row.delay_minutes),
  };
}

function mapJobRow(row: any): DownsellJobRow {
  return {
    id: Number(row.id),
    bot_slug: String(row.bot_slug),
    downsell_id: Number(row.downsell_id),
    telegram_id: Number(row.telegram_id),
    scheduled_at:
      row.scheduled_at instanceof Date ? row.scheduled_at : new Date(row.scheduled_at),
    sent_at: row.sent_at ? (row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at)) : null,
    status: String(row.status),
    attempts: Number(row.attempts ?? 0),
    last_error: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
  };
}

async function loadDownsell(downsellId: number) {
  const { rows } = await pool.query(
    `select id, bot_slug, copy, media_url, media_type
       from public.bot_downsells
      where id = $1`,
    [downsellId]
  );
  return rows[0] ?? null;
}

function computeNextBackoffSec(attempts: number): number {
  const attemptIndex = Math.max(1, attempts);
  const base = 20 * Math.pow(3, attemptIndex - 1);
  return Math.min(300, Math.round(base));
}

export async function scheduleDownsellsForTrigger(params: {
  bot_slug: string;
  telegram_id: number;
  trigger: TriggerType;
  triggerAt: Date;
}): Promise<void> {
  const { bot_slug, telegram_id, trigger, triggerAt } = params;
  const downsellsResult = await pool.query(
    `select id, delay_minutes
       from public.bot_downsells
      where bot_slug = $1
        and active = true
        and trigger = $2
      order by delay_minutes asc, id asc`,
    [bot_slug, trigger]
  );

  const downsells = downsellsResult.rows.map(mapDownsell);

  if (downsells.length === 0) {
    serviceLogger.debug({ bot_slug, trigger, telegram_id }, '[DWN][enqueue] none');
    return;
  }

  for (const downsell of downsells) {
    const delay = parseDelayMinutes(downsell.delay_minutes);
    const scheduledAt = new Date(triggerAt.getTime() + delay * 60_000);

    try {
      const insertResult = await pool.query(
        `insert into public.bot_downsell_jobs (bot_slug, downsell_id, telegram_id, scheduled_at)
         values ($1, $2, $3, $4)
         on conflict (downsell_id, telegram_id) do nothing`,
        [bot_slug, downsell.id, telegram_id, scheduledAt]
      );

      if (insertResult.rowCount && insertResult.rowCount > 0) {
        serviceLogger.info(
          {
            bot_slug,
            telegram_id,
            downsell_id: downsell.id,
            scheduled_at: scheduledAt.toISOString(),
          },
          '[DWN][enqueue] ok'
        );
      } else {
        serviceLogger.debug(
          { bot_slug, telegram_id, downsell_id: downsell.id },
          '[DWN][enqueue] already'
        );
      }
    } catch (err) {
      serviceLogger.warn(
        {
          bot_slug,
          telegram_id,
          downsell_id: downsell.id,
          err: err instanceof Error ? err.message : String(err),
        },
        '[DWN][enqueue] skip'
      );
    }
  }
}

async function fetchDueJobs(limit = 50): Promise<DownsellJobRow[]> {
  const { rows } = await pool.query(
    `with cte as (
       select id
         from public.bot_downsell_jobs
        where status = 'pending'
          and scheduled_at <= now()
        order by scheduled_at asc
        limit $1
        for update skip locked
     )
     update public.bot_downsell_jobs j
        set status = 'processing',
            attempts = j.attempts + 1
       from cte
      where j.id = cte.id
    returning j.*`,
    [limit]
  );

  return rows.map(mapJobRow);
}

async function sendJob(job: DownsellJobRow): Promise<void> {
  const downsell = await loadDownsell(job.downsell_id);
  if (!downsell) {
    throw new Error('downsells_not_found');
  }

  if (String(downsell.bot_slug) !== job.bot_slug) {
    throw new Error('bot_slug_mismatch');
  }

  const botConfig = await botRegistry.getBotBySlug(job.bot_slug);
  if (!botConfig?.token) {
    throw new Error(`bot_not_found:${job.bot_slug}`);
  }

  const token = botConfig.token;
  const chatId = job.telegram_id;
  const copy = typeof downsell.copy === 'string' ? downsell.copy : '';
  const mediaUrl = typeof downsell.media_url === 'string' ? downsell.media_url.trim() : '';
  const mediaType = typeof downsell.media_type === 'string' ? downsell.media_type.toLowerCase() : '';
  const mediaKey = `downsell:${job.downsell_id}`;
  const chatIdStr = String(chatId);

  if (mediaUrl) {
    let method: string | null = null;
    let field: string | null = null;
    let route = 'downsell_media';
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      caption: copy || undefined,
    };

    switch (mediaType) {
      case 'photo':
        method = 'sendPhoto';
        field = 'photo';
        route = 'downsell_photo';
        break;
      case 'video':
        method = 'sendVideo';
        field = 'video';
        payload['supports_streaming'] = true;
        route = 'downsell_video';
        break;
      case 'audio':
        method = 'sendAudio';
        field = 'audio';
        route = 'downsell_audio';
        break;
      case 'voice':
        method = 'sendVoice';
        field = 'voice';
        route = 'downsell_voice';
        break;
      case 'document':
        method = 'sendDocument';
        field = 'document';
        route = 'downsell_document';
        break;
      default:
        method = 'sendMessage';
        route = 'downsell_text_fallback';
        break;
    }

    if (method === 'sendMessage') {
      if (!copy.trim()) {
        throw new Error('empty_message_payload');
      }
      const response = await profileSend(
        { bot_slug: job.bot_slug, chat_id: chatIdStr, media_key: mediaKey, route },
        () =>
          telegramMediaCache.callTelegram(method!, token, {
            chat_id: chatId,
            text: copy,
            disable_web_page_preview: true,
          })
      );
      if (!response.ok) {
        const description = response.description ?? 'telegram_send_error';
        throw new Error(`telegram_error:${response.error_code ?? 'unknown'}:${description}`);
      }
      return;
    }

    if (!field) {
      throw new Error('unsupported_media_type');
    }

    const response = await profileSend(
      { bot_slug: job.bot_slug, chat_id: chatIdStr, media_key: mediaKey, route },
      () =>
        telegramMediaCache.callTelegram(method!, token, {
          ...payload,
          [field!]: mediaUrl,
        })
    );

    if (!response.ok) {
      const description = response.description ?? 'telegram_send_error';
      throw new Error(`telegram_error:${response.error_code ?? 'unknown'}:${description}`);
    }
    return;
  }

  if (!copy.trim()) {
    throw new Error('empty_message_payload');
  }

  const response = await profileSend(
    { bot_slug: job.bot_slug, chat_id: chatIdStr, media_key: mediaKey, route: 'downsell_text' },
    () =>
      telegramMediaCache.callTelegram('sendMessage', token, {
        chat_id: chatId,
        text: copy,
        disable_web_page_preview: true,
      })
  );

  if (!response.ok) {
    const description = response.description ?? 'telegram_send_error';
    throw new Error(`telegram_error:${response.error_code ?? 'unknown'}:${description}`);
  }
}

async function completeJob(jobId: number): Promise<void> {
  await pool.query(
    `update public.bot_downsell_jobs
        set status = 'sent',
            sent_at = now()
      where id = $1`,
    [jobId]
  );
}

async function failJob(job: DownsellJobRow, err: unknown): Promise<void> {
  const attempts = job.attempts;
  const message = err instanceof Error ? err.message : String(err);
  const trimmedMessage = message.length > 500 ? `${message.slice(0, 497)}...` : message;

  if (attempts >= MAX_ATTEMPTS) {
    await pool.query(
      `update public.bot_downsell_jobs
          set status = 'failed',
              last_error = $2
        where id = $1`,
      [job.id, trimmedMessage]
    );
    serviceLogger.error(
      { id: job.id, downsell_id: job.downsell_id, attempts, err: trimmedMessage },
      '[DWN][error] giving up'
    );
    return;
  }

  const waitSec = computeNextBackoffSec(attempts);
  await pool.query(
    `update public.bot_downsell_jobs
        set status = 'pending',
            last_error = $2,
            scheduled_at = now() + make_interval(secs => $3::int)
      where id = $1`,
    [job.id, trimmedMessage, waitSec]
  );
  serviceLogger.warn(
    {
      id: job.id,
      downsell_id: job.downsell_id,
      attempts,
      wait_seconds: waitSec,
      err: trimmedMessage,
    },
    '[DWN][error] retry scheduled'
  );
}

export async function workOnce(limit = 30): Promise<void> {
  const jobs = await fetchDueJobs(limit);
  if (!jobs.length) {
    return;
  }

  for (const job of jobs) {
    try {
      await sendJob(job);
      await completeJob(job.id);
      serviceLogger.info(
        { id: job.id, downsell_id: job.downsell_id, telegram_id: job.telegram_id },
        '[DWN][send] ok'
      );
    } catch (err) {
      serviceLogger.error(
        {
          id: job.id,
          downsell_id: job.downsell_id,
          telegram_id: job.telegram_id,
          err: err instanceof Error ? err.message : String(err),
        },
        '[DWN][send] fail'
      );
      await failJob(job, err);
    }
  }
}

let workerStarted = false;

export function startWorker(): void {
  if (workerStarted) {
    return;
  }
  workerStarted = true;

  const intervalRaw = Number(process.env.DOWNSELL_WORKER_INTERVAL_MS ?? '15000');
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : 15000;

  const tick = () => {
    void workOnce().catch((err) => {
      serviceLogger.error(
        { err: err instanceof Error ? err.message : String(err) },
        '[DWN][worker] tick error'
      );
    });
  };

  tick();
  setInterval(tick, intervalMs);
  serviceLogger.info({ intervalMs }, '[DWN][worker] started');
}

export const __testing = {
  parseDelayMinutes,
  computeNextBackoffSec,
};

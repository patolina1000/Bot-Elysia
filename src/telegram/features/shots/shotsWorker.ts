import { getPool } from '../../db/pool';
import { logger } from '../../../logger.js';
import { deliverShot, type ShotHeader as DeliverableShotHeader } from './deliver.js';

// Manter true para acompanhar em produção
const LOG_JOBS = true;
function ts(): string {
  return new Date().toISOString();
}

const MAX_ATTEMPTS = 5;
function computeBackoffMs(currentAttempt: number): number {
  // tentativa 0→30s, 1→60s, 2→120s, 3→300s, ≥4→600s
  const table = [30, 60, 120, 300, 600];
  const idx = Math.min(currentAttempt, table.length - 1);
  return table[idx] * 1000;
}

const workerLogger = logger.child({ worker: 'shots' });

type ChatId = string | number;

type ShotHeader = DeliverableShotHeader & {
  status: string | null;
};

type QueueRow = {
  id: number;
  shot_id: number;
  telegram_id: ChatId;
  attempt_count: number;
};

type JobLogInfo = {
  id: number;
  shot_id: number;
  telegram_id: ChatId;
  attempt_count: number;
};

function logJob(job: JobLogInfo, message: string, extra?: unknown): void {
  if (!LOG_JOBS) {
    return;
  }
  const base = `[${ts()}][SHOTS][JOB id=${job.id} shot=${job.shot_id} tg=${job.telegram_id} try=${job.attempt_count}]`;
  if (extra !== undefined) {
    console.log(base, message, extra);
  } else {
    console.log(base, message);
  }
}

function normalizeChatId(raw: unknown): ChatId {
  if (typeof raw === 'bigint') {
    return raw.toString();
  }
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error('Invalid telegram id');
    }
    return trimmed;
  }
  if (raw === null || raw === undefined) {
    throw new Error('Missing telegram id');
  }
  return String(raw);
}

function mapQueueRow(row: any): QueueRow {
  const id = Number(row.id);
  const shotId = Number(row.shot_id);
  if (!Number.isFinite(id) || !Number.isFinite(shotId)) {
    throw new Error('Invalid queue row identifiers');
  }

  const attemptCount = Number(row.attempt_count ?? 0);
  if (!Number.isFinite(attemptCount) || attemptCount < 0) {
    throw new Error('Invalid attempt count');
  }

  return {
    id,
    shot_id: shotId,
    telegram_id: normalizeChatId(row.telegram_id),
    attempt_count: attemptCount,
  };
}

const ALLOWED_MEDIA_TYPES: DeliverableShotHeader['media_type'][] = [
  'text',
  'photo',
  'video',
  'audio',
  'animation',
];

function normalizeMediaType(raw: unknown): DeliverableShotHeader['media_type'] {
  if (typeof raw === 'string') {
    const lowered = raw.trim().toLowerCase();
    if (ALLOWED_MEDIA_TYPES.includes(lowered as DeliverableShotHeader['media_type'])) {
      return lowered as DeliverableShotHeader['media_type'];
    }
  }
  return 'text';
}

function mapShotHeader(row: any): ShotHeader {
  const id = Number(row.id);
  if (!Number.isFinite(id)) {
    throw new Error('Invalid shot identifier');
  }

  return {
    id,
    bot_slug: String(row.bot_slug ?? ''),
    media_type: normalizeMediaType(row.media_type),
    message_text: typeof row.message_text === 'string' ? row.message_text : null,
    media_url: typeof row.media_url === 'string' ? row.media_url : null,
    parse_mode: typeof row.parse_mode === 'string' ? row.parse_mode : null,
    status: typeof row.status === 'string' ? row.status : null,
  };
}

export async function processDueShots(
  batchSize = 100
): Promise<{ picked: number; sent: number }> {
  const pool = await getPool();
  const client = await pool.connect();

  let picked: QueueRow[] = [];
  let headerById: Map<number, ShotHeader> = new Map();

  try {
    await client.query('BEGIN');

    const pickSql = `
      WITH due AS (
        SELECT q.id
          FROM public.shots_queue q
          JOIN public.shots s ON s.id = q.shot_id
         WHERE q.status = 'scheduled'
           AND q.deliver_at <= NOW()
           AND COALESCE(s.status, 'scheduled') <> 'canceled'
         ORDER BY q.deliver_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      UPDATE public.shots_queue q
         SET status = 'sending',
             updated_at = NOW()
        FROM due
       WHERE q.id = due.id
      RETURNING q.id, q.shot_id, q.telegram_id, COALESCE(q.attempt_count, 0) AS attempt_count
    `;
    const { rows: pickedRows } = await client.query(pickSql, [batchSize]);
    picked = pickedRows.map(mapQueueRow);

    if (picked.length === 0) {
      await client.query('COMMIT');
      if (LOG_JOBS) {
        console.log(`[${ts()}][SHOTS] nenhuma tarefa vencida (batchSize=${batchSize})`);
      }
      return { picked: 0, sent: 0 };
    }

    const shotIds = [...new Set(picked.map((row) => row.shot_id))];
    const { rows: shotRows } = await client.query(
      `
        SELECT s.id,
               s.bot_slug,
               s.media_type,
               s.message_text,
               s.media_url,
               s.parse_mode,
               s.status
          FROM public.shots s
         WHERE s.id = ANY($1::bigint[])
      `,
      [shotIds]
    );

    headerById = new Map<number, ShotHeader>(shotRows.map((row) => {
      const header = mapShotHeader(row);
      return [header.id, header];
    }));

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  let sent = 0;
  for (const job of picked) {
    logJob(job, 'processando');
    const header = headerById.get(job.shot_id);
    if (!header) {
      logJob(job, 'faltando header — marcando erro');
      workerLogger.warn({ jobId: job.id, shotId: job.shot_id }, '[SHOTS][WORKER] missing shot header');
      await markJobAsError(job.id, `Missing shot header ${job.shot_id}`);
      continue;
    }

    const status = typeof header.status === 'string' ? header.status.toLowerCase() : '';
    if (status === 'canceled') {
      logJob(job, 'shot cancelado — pulando');
      workerLogger.info({ jobId: job.id, shotId: job.shot_id }, '[SHOTS][WORKER] shot canceled, skipping job');
      await skipJob(job, 'shot-canceled');
      continue;
    }

    try {
      logJob(job, `enviando media_type=${header.media_type}`);
      await deliverShot(header, job.telegram_id);
      await markJobAsSent(job);
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      logJob(job, 'falha no envio — reprogramando', message);
      workerLogger.error({ err, jobId: job.id, shotId: job.shot_id }, '[SHOTS][WORKER] failed to deliver shot');
      await scheduleRetry(job, message);
    }
  }

  return { picked: picked.length, sent };
}

async function markJobAsSent(job: QueueRow): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE public.shots_queue
        SET status='sent', last_error=NULL, updated_at=NOW()
      WHERE id=$1`,
    [job.id]
  );
  logJob(job, 'marcado como sent');
}

async function skipJob(job: QueueRow, reason: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE public.shots_queue
        SET status='skipped', updated_at=NOW()
      WHERE id=$1`,
    [job.id]
  );
  logJob(job, `skipped (${reason})`);
}

async function markJobAsError(queueId: number, errMsg: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE public.shots_queue
        SET status='error', last_error=$2, updated_at=NOW()
      WHERE id=$1`,
    [queueId, errMsg]
  );
}

async function scheduleRetry(job: QueueRow, errMsg: string): Promise<void> {
  const pool = await getPool();
  const nextAttempt = job.attempt_count + 1;
  if (nextAttempt >= MAX_ATTEMPTS) {
    logJob({ ...job, attempt_count: nextAttempt }, 'estourou tentativas → error:', errMsg);
    await pool.query(
      `UPDATE public.shots_queue
          SET status='error',
              attempt_count=$2,
              last_error=$3,
              updated_at=NOW()
        WHERE id=$1`,
      [job.id, nextAttempt, errMsg]
    );
    return;
  }

  const deliverAt = new Date(Date.now() + computeBackoffMs(job.attempt_count));
  logJob(
    { ...job, attempt_count: nextAttempt },
    `reagendado para ${deliverAt.toISOString()} (attempt=${nextAttempt}) motivo=${errMsg}`
  );
  await pool.query(
    `UPDATE public.shots_queue
        SET status='scheduled',
            attempt_count=$2,
            last_error=$3,
            deliver_at=$4,
            updated_at=NOW()
      WHERE id=$1`,
    [job.id, nextAttempt, errMsg, deliverAt]
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runShotsWorkerForever(
  options: { batchSize?: number; intervalMs?: number } = {}
): Promise<void> {
  const batchSize = options.batchSize ?? 100;
  const intervalMs = options.intervalMs ?? 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await processDueShots(batchSize);
    } catch (err) {
      workerLogger.error({ err }, '[SHOTS][WORKER] loop iteration failed');
    }
    await delay(intervalMs);
  }
}

export async function startShotsWorker(
  options: { batchSize?: number; intervalMs?: number } = {}
): Promise<NodeJS.Timeout> {
  const batchSize = options.batchSize ?? 100;
  const intervalMs = options.intervalMs ?? 1000;

  const tick = async () => {
    try {
      const result = await processDueShots(batchSize);
      if (result.picked > 0) {
        workerLogger.info({ picked: result.picked, sent: result.sent }, '[SHOTS][WORKER] processed batch');
      }
    } catch (err) {
      workerLogger.error({ err }, '[SHOTS][WORKER] tick failed');
    }
  };

  await tick();

  const interval = setInterval(() => {
    void tick();
  }, intervalMs);

  return interval;
}

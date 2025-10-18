import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { ShotQueueJob } from '../../src/db/shotsQueue.js';
import type { ShotPlanRow, ShotRow } from '../../src/repositories/ShotsRepo.js';
import type { BotLike } from '../../src/services/shots/ShotsMessageBuilder.js';

function ensureEnv(): void {
  process.env.PORT ??= '8080';
  process.env.APP_BASE_URL ??= 'https://example.com';
  process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
  process.env.ENCRYPTION_KEY ??= '1234567890123456';
  process.env.ADMIN_API_TOKEN ??= 'admintoken123';
  process.env.NODE_ENV ??= 'development';
}

type WorkerModule = typeof import('../../src/services/shots/worker.js');
type Dependencies = WorkerModule['__dependencies'];
type ProcessShotQueueJobFn = WorkerModule['__private__']['processShotQueueJob'];

let processShotQueueJob: ProcessShotQueueJobFn;
let dependencies: Dependencies;
let originalDependencies: Dependencies;
let pool: typeof import('../../src/db/pool.js')['pool'];

let logMessages: string[] = [];
let recordShotCalls: any[] = [];
let markSuccessCalls: any[] = [];
let markErrorCalls: any[] = [];
let markProcessingCalls: any[] = [];
let scheduleRetryCalls: any[] = [];
let insertShotSentCalls: any[] = [];
let insertShotErrorCalls: any[] = [];
let funnelEvents: Map<string, { eventName: string; telegramId: string; meta: any }> = new Map();

function resetState(): void {
  logMessages = [];
  recordShotCalls = [];
  markSuccessCalls = [];
  markErrorCalls = [];
  markProcessingCalls = [];
  scheduleRetryCalls = [];
  insertShotSentCalls = [];
  insertShotErrorCalls = [];
  funnelEvents = new Map();
}

function createJob(overrides: Partial<ShotQueueJob> = {}): ShotQueueJob {
  const now = new Date('2025-01-01T00:00:00Z');
  return {
    id: 1000,
    shot_id: 2000,
    bot_slug: 'demo-bot',
    target: null,
    copy: '',
    media_url: null,
    media_type: 'none',
    telegram_id: 987654321,
    scheduled_at: now,
    status: 'pending',
    attempt_count: 0,
    attempts: 0,
    next_retry_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function setupLoggerCapture(): Promise<void> {
  const { logger } = await import('../../src/logger.js');

  const capture = (args: any[]): void => {
    const maybeMessage = args.at(-1);
    if (typeof maybeMessage === 'string' && maybeMessage.startsWith('[SHOTS]')) {
      logMessages.push(maybeMessage);
    }
  };

  mock.method(logger, 'info', (...args: any[]) => {
    capture(args);
    return logger;
  });

  mock.method(logger, 'debug', (...args: any[]) => {
    capture(args);
    return logger;
  });

  mock.method(logger, 'warn', (...args: any[]) => {
    capture(args);
    return logger;
  });

  mock.method(logger, 'error', (...args: any[]) => {
    capture(args);
    return logger;
  });

  mock.method(logger, 'child', () => ({
    info: (...args: any[]) => capture(args),
    error: (...args: any[]) => capture(args),
    warn: (...args: any[]) => capture(args),
    debug: (...args: any[]) => capture(args),
  }));
}

function mockFunnelEvents(): void {
  mock.method(pool, 'query', async (sql: string, params: any[]) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO funnel_events')) {
      const [eventId, eventName, telegramId, metaJson] = params ?? [];
      const meta = typeof metaJson === 'string' ? JSON.parse(metaJson) : metaJson;
      if (!funnelEvents.has(eventId)) {
        funnelEvents.set(eventId, { eventName, telegramId, meta });
        return { rowCount: 1 } as any;
      }
      return { rowCount: 0 } as any;
    }

    return { rows: [], rowCount: 0 } as any;
  });
}

type Scenario = { shot: ShotRow; plans: ShotPlanRow[]; bot: { api: BotLike } };

function createBotLike(overrides: Partial<BotLike> = {}): BotLike {
  const noop = async (..._args: any[]) => ({ message_id: 0 });
  return {
    sendChatAction: async (..._args: any[]) => undefined,
    sendPhoto: noop,
    sendVideo: noop,
    sendAudio: noop,
    sendDocument: noop,
    sendMessage: async (..._args: any[]) => ({ message_id: 0 }),
    ...overrides,
  };
}

async function configureDependencies(job: ShotQueueJob, scenario: Scenario): Promise<void> {
  let attempts = job.attempts ?? job.attempt_count ?? 0;

  dependencies.getShotWithPlans = async (shotId: number) => {
    assert.equal(shotId, scenario.shot.id);
    return { shot: scenario.shot, plans: scenario.plans };
  };

  dependencies.getOrCreateBotBySlug = async (slug: string) => {
    assert.equal(slug, scenario.shot.bot_slug);
    return scenario.bot as unknown as any;
  };

  dependencies.recordShotSent = async (params: any) => {
    recordShotCalls.push(params);
  };

  dependencies.markShotQueueProcessing = async (id: number, client: any) => {
    markProcessingCalls.push({ id, client });
    attempts += 1;
    return {
      ...job,
      id,
      attempts,
      attempt_count: attempts,
      status: 'processing',
    };
  };

  dependencies.markShotQueueSuccess = async (id: number, client: any) => {
    markSuccessCalls.push({ id, client });
    return { ...job, id, status: 'success' };
  };

  dependencies.markShotQueueError = async (id: number, error: string, client: any) => {
    markErrorCalls.push({ id, error, client });
    return null;
  };

  dependencies.scheduleShotQueueRetry = async (
    id: number,
    error: string,
    next_retry_at: Date,
    client: any
  ) => {
    scheduleRetryCalls.push({ id, error, next_retry_at, client });
    return { ...job, id, status: 'pending', next_retry_at, last_error: error };
  };

  const funnelModule = await import('../../src/repositories/FunnelEventsRepo.js');

  dependencies.insertShotSent = async (params: any) => {
    insertShotSentCalls.push(params);
    await funnelModule.FunnelEventsRepo.insertShotSent(params);
  };

  dependencies.insertShotError = async (params: any) => {
    insertShotErrorCalls.push(params);
    await funnelModule.FunnelEventsRepo.insertShotError(params);
  };
}

test.before(async () => {
  ensureEnv();
  const workerModule: WorkerModule = await import('../../src/services/shots/worker.js');
  const exports = (workerModule as any).default ?? workerModule;
  ({ processShotQueueJob, __dependencies: dependencies } = exports.__private__);
  originalDependencies = { ...dependencies };
  ({ pool } = await import('../../src/db/pool.js'));
});

test.afterEach(() => {
  dependencies.getShotWithPlans = originalDependencies.getShotWithPlans;
  dependencies.getOrCreateBotBySlug = originalDependencies.getOrCreateBotBySlug;
  dependencies.recordShotSent = originalDependencies.recordShotSent;
  dependencies.markShotQueueSuccess = originalDependencies.markShotQueueSuccess;
  dependencies.markShotQueueError = originalDependencies.markShotQueueError;
  dependencies.markShotQueueProcessing = originalDependencies.markShotQueueProcessing;
  dependencies.scheduleShotQueueRetry = originalDependencies.scheduleShotQueueRetry;
  dependencies.insertShotSent = originalDependencies.insertShotSent;
  dependencies.insertShotError = originalDependencies.insertShotError;
  mock.restoreAll();
  resetState();
});

test('shot_sent event is recorded with correlation logs', async () => {
  await setupLoggerCapture();
  mockFunnelEvents();

  const job = createJob({ id: 42, shot_id: 77, bot_slug: 'promo-bot', telegram_id: 998877 });
  const scenario: Scenario = {
    shot: {
      id: 77,
      bot_slug: 'promo-bot',
      title: 'Promo',
      copy: 'Bem-vindo!',
      media_url: null,
      media_type: 'none',
      scheduled_at: new Date('2025-02-01T10:00:00Z'),
      target: 'all_started',
      created_at: new Date('2025-01-20T10:00:00Z'),
    },
    plans: [
      { id: 1, shot_id: 77, name: 'Plano Único', price_cents: 1990, description: null, sort_order: 1 },
    ],
    bot: {
      api: createBotLike({
        sendMessage: async (...args: any[]) => ({ message_id: 501, args }),
      }),
    },
  };

  await configureDependencies(job, scenario);

  await processShotQueueJob(job, {} as any);

  assert.equal(insertShotSentCalls.length, 1);
  assert.deepEqual(insertShotSentCalls[0], {
    shotId: 77,
    botSlug: 'promo-bot',
    telegramId: BigInt(998877),
    target: 'all_started',
  });
  assert.equal(insertShotErrorCalls.length, 0);

  const eventId = 'shs:77:998877';
  assert.ok(funnelEvents.has(eventId));
  assert.deepEqual(funnelEvents.get(eventId), {
    eventName: 'shot_sent',
    telegramId: '998877',
    meta: { shot_id: 77, bot_slug: 'promo-bot', target: 'all_started' },
  });

  assert.equal(markSuccessCalls.length, 1);
  assert.equal(markErrorCalls.length, 0);

  const corr = 'q:42|sh:77|tg:998877';
  assert.ok(
    logMessages.some((msg) => msg.startsWith('[SHOTS][WORKER][DEQUEUE]') && msg.includes(`corr="${corr}"`))
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][SEND][INTRO]') &&
        msg.includes('chatId=998877') &&
        msg.includes(`corr="${corr}"`)
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][SEND][PLANS] chatId=998877 plans=1') &&
        msg.includes(`corr="${corr}"`)
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][EVENT] name=shot_sent event_id=shs:77:998877') &&
        msg.includes(`corr="${corr}"`)
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][QUEUE][DONE] id=42 status=success attempts=1') &&
        msg.includes(`corr="${corr}"`)
    )
  );
});

test('shot_error event stores attempt and sanitized error', async () => {
  await setupLoggerCapture();
  mockFunnelEvents();

  const job = createJob({
    id: 55,
    shot_id: 88,
    bot_slug: 'error-bot',
    telegram_id: 112233,
    attempts: 0,
    attempt_count: 0,
  });
  const scenario: Scenario = {
    shot: {
      id: 88,
      bot_slug: 'error-bot',
      title: 'Erro',
      copy: 'teste',
      media_url: null,
      media_type: 'none',
      scheduled_at: new Date('2025-03-02T12:00:00Z'),
      target: 'all_started',
      created_at: new Date('2025-02-20T12:00:00Z'),
    },
    plans: [],
    bot: {
      api: createBotLike({
        sendMessage: async (...args: any[]) => ({ message_id: 601, args }),
      }),
    },
  };

  await configureDependencies(job, scenario);

  const builderModule = await import('../../src/services/shots/ShotsMessageBuilder.js');
  mock.method(builderModule.ShotsMessageBuilder, 'sendShotIntro', async () => {
    throw new Error('Falha muito longa '.repeat(50));
  });

  await processShotQueueJob(job, {} as any);

  assert.equal(insertShotSentCalls.length, 0);
  assert.equal(insertShotErrorCalls.length, 1);
  assert.deepEqual(insertShotErrorCalls[0], {
    shotId: 88,
    botSlug: 'error-bot',
    telegramId: BigInt(112233),
    target: 'all_started',
    attempt: 1,
    errorMessage: 'Falha muito longa '.repeat(50),
  });

  const eventId = 'she:88:112233:1';
  assert.ok(funnelEvents.has(eventId));
  const stored = funnelEvents.get(eventId);
  assert.equal(stored?.eventName, 'shot_error');
  assert.equal(stored?.telegramId, '112233');
  assert.equal(stored?.meta.shot_id, 88);
  assert.equal(stored?.meta.bot_slug, 'error-bot');
  assert.equal(stored?.meta.target, 'all_started');
  assert.equal(stored?.meta.attempt, 1);
  const errorText = String(stored?.meta.error ?? '');
  assert.ok(errorText.length <= 500);
  assert.ok(errorText.startsWith('Falha muito longa'));

  assert.equal(scheduleRetryCalls.length, 1);
  assert.equal(markErrorCalls.length, 0);

  const corr = 'q:55|sh:88|tg:112233';
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][WORKER][DEQUEUE] id=55') &&
        msg.includes(`corr="${corr}"`)
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][EVENT] name=shot_error event_id=she:88:112233:1') &&
        msg.includes(`corr="${corr}"`)
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][QUEUE][DONE] id=55 status=error attempts=1') &&
        msg.includes(`corr="${corr}"`)
    )
  );
});

test('shot_sent deduplicates while shot_error keeps attempts', async () => {
  mockFunnelEvents();

  const scenario: Scenario = {
    shot: {
      id: 123,
      bot_slug: 'dup-bot',
      title: 'Dup',
      copy: 'Olá',
      media_url: null,
      media_type: 'none',
      scheduled_at: new Date('2025-04-10T09:00:00Z'),
      target: 'all_started',
      created_at: new Date('2025-03-30T09:00:00Z'),
    },
    plans: [],
    bot: {
      api: createBotLike({
        sendMessage: async (...args: any[]) => ({ message_id: 701, args }),
      }),
    },
  };

  const successJob = createJob({ id: 90, shot_id: 123, bot_slug: 'dup-bot', telegram_id: 445566 });
  await configureDependencies(successJob, scenario);
  await processShotQueueJob(successJob, {} as any);
  assert.ok(funnelEvents.has('shs:123:445566'));
  const sizeAfterFirst = funnelEvents.size;

  await configureDependencies(successJob, scenario);
  await processShotQueueJob(successJob, {} as any);
  assert.equal(funnelEvents.size, sizeAfterFirst);

  const builderModule = await import('../../src/services/shots/ShotsMessageBuilder.js');
  let failureCount = 0;
  mock.method(builderModule.ShotsMessageBuilder, 'sendShotIntro', async () => {
    failureCount += 1;
    throw new Error(`Erro tentativa ${failureCount}`);
  });

  const errorJob1 = createJob({
    id: 91,
    shot_id: 123,
    bot_slug: 'dup-bot',
    telegram_id: 445566,
    attempts: 0,
    attempt_count: 0,
  });
  await configureDependencies(errorJob1, scenario);
  await processShotQueueJob(errorJob1, {} as any);
  assert.ok(funnelEvents.has('she:123:445566:1'));

  const errorJob2 = createJob({
    id: 92,
    shot_id: 123,
    bot_slug: 'dup-bot',
    telegram_id: 445566,
    attempts: 1,
    attempt_count: 1,
  });
  await configureDependencies(errorJob2, scenario);
  await processShotQueueJob(errorJob2, {} as any);
  assert.ok(funnelEvents.has('she:123:445566:2'));

});

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { ShotQueueJob } from '../../src/db/shotsQueue.ts';
import type { RecordShotSentParams } from '../../src/db/shotsSent.ts';
import type { ShotPlanRow, ShotRow } from '../../src/repositories/ShotsRepo.ts';

function ensureEnv(): void {
  process.env.PORT ??= '8080';
  process.env.APP_BASE_URL ??= 'https://example.com';
  process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
  process.env.ENCRYPTION_KEY ??= '1234567890123456';
  process.env.ADMIN_API_TOKEN ??= 'admintoken123';
  process.env.NODE_ENV ??= 'development';
}

type ProcessShotQueueJobFn = (job: ShotQueueJob, client: any) => Promise<void>;

type Dependencies = typeof import('../../src/services/shots/worker.ts')['__dependencies'];

type Scenario = { shot: ShotRow; plans: ShotPlanRow[] };

type FakeApi = {
  sendChatAction?: (chatId: number, action: string) => Promise<any>;
  sendPhoto?: (chatId: number, url: string, options?: any) => Promise<any>;
  sendVideo?: (chatId: number, url: string, options?: any) => Promise<any>;
  sendMessage: (chatId: number, text: string, options: any) => Promise<any>;
};

let processShotQueueJob: ProcessShotQueueJobFn;
let dependencies: Dependencies;

let currentScenario: Scenario | null = null;
let currentBotApi: { api: FakeApi } | null = null;
let lastJob: ShotQueueJob | null = null;
let logMessages: string[] = [];
let recordShotCalls: RecordShotSentParams[] = [];
let markSuccessCalls: { id: number; client: any }[] = [];
let markErrorCalls: { id: number; error: string; client: any }[] = [];
let markProcessingCalls: { id: number; client: any }[] = [];
let scheduleRetryCalls: { id: number; error: string; next_retry_at: Date; client: any }[] = [];
let requestedBotSlugs: string[] = [];
let insertShotSentCalls: any[] = [];
let insertShotErrorCalls: any[] = [];

let originalDependencies: Dependencies;

function createJob(overrides: Partial<ShotQueueJob> = {}): ShotQueueJob {
  const now = new Date();
  return {
    id: 100,
    shot_id: 200,
    bot_slug: 'demo-bot',
    target: null,
    copy: '',
    media_url: null,
    media_type: 'none',
    telegram_id: 123456,
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

function resetState(): void {
  currentScenario = null;
  currentBotApi = null;
  lastJob = null;
  logMessages = [];
  recordShotCalls = [];
  markSuccessCalls = [];
  markErrorCalls = [];
  markProcessingCalls = [];
  scheduleRetryCalls = [];
  requestedBotSlugs = [];
  insertShotSentCalls = [];
  insertShotErrorCalls = [];
}

async function setupLoggerCapture(): Promise<void> {
  const loggerModule = await import('../../src/logger.ts');
  const logger = loggerModule.default?.logger ?? (loggerModule as any).logger;

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

  mock.method(logger, 'warn', () => logger);

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

function configureDependencies(fakeClientResult: { telegram_id: number }): void {
  dependencies.getShotWithPlans = async (shotId: number) => {
    if (!currentScenario) {
      throw new Error('Scenario not configured');
    }
    if (currentScenario.shot.id !== shotId) {
      throw new Error(`Unexpected shot id ${shotId}`);
    }
    logMessages.push(`[SHOTS][LOAD] shotId=${shotId} plans=${currentScenario.plans.length}`);
    return currentScenario;
  };

  dependencies.getOrCreateBotBySlug = async (slug: string) => {
    requestedBotSlugs.push(slug);
    if (!currentBotApi) {
      throw new Error('Bot API not configured');
    }
    return currentBotApi;
  };

  dependencies.recordShotSent = async (params: RecordShotSentParams) => {
    recordShotCalls.push(params);
  };

  dependencies.insertShotSent = async (params: any) => {
    insertShotSentCalls.push(params);
  };

  dependencies.insertShotError = async (params: any) => {
    insertShotErrorCalls.push(params);
  };

  dependencies.markShotQueueSuccess = async (id: number, client: any) => {
    markSuccessCalls.push({ id, client });
    const shot = currentScenario?.shot;
    return {
      id,
      shot_id: shot?.id ?? id,
      bot_slug: shot?.bot_slug ?? 'unknown',
      target: null,
      copy: '',
      media_url: null,
      media_type: 'none',
      telegram_id: fakeClientResult.telegram_id,
      scheduled_at: null,
      status: 'success',
      attempt_count: 0,
      attempts: 0,
      next_retry_at: null,
      last_error: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
  };

  dependencies.markShotQueueError = async (id: number, error: string, client: any) => {
    markErrorCalls.push({ id, error, client });
    return null;
  };

  dependencies.markShotQueueProcessing = async (id: number, client: any) => {
    markProcessingCalls.push({ id, client });
    const baseJob = lastJob ?? createJob({ id });
    const attempts = (baseJob.attempts ?? 0) + 1;
    return {
      ...baseJob,
      id,
      attempts,
      attempt_count: attempts,
      status: 'processing',
    };
  };

  dependencies.scheduleShotQueueRetry = async (
    id: number,
    error: string,
    next_retry_at: Date,
    client: any
  ) => {
    scheduleRetryCalls.push({ id, error, next_retry_at, client });
    return {
      ...(lastJob ?? createJob({ id })),
      id,
      status: 'pending',
      last_error: error,
      next_retry_at,
    };
  };
}

test.before(async () => {
  ensureEnv();
  const workerModule = await import('../../src/services/shots/worker.ts');
  const exports = (workerModule as any).default ?? workerModule;
  ({ processShotQueueJob, __dependencies: dependencies } = exports.__private__);
  originalDependencies = { ...dependencies };
});

test.afterEach(() => {
  dependencies.getShotWithPlans = originalDependencies.getShotWithPlans;
  dependencies.getOrCreateBotBySlug = originalDependencies.getOrCreateBotBySlug;
  dependencies.markShotQueueSuccess = originalDependencies.markShotQueueSuccess;
  dependencies.markShotQueueError = originalDependencies.markShotQueueError;
  dependencies.markShotQueueProcessing = originalDependencies.markShotQueueProcessing;
  dependencies.scheduleShotQueueRetry = originalDependencies.scheduleShotQueueRetry;
  dependencies.recordShotSent = originalDependencies.recordShotSent;
  dependencies.insertShotSent = originalDependencies.insertShotSent;
  dependencies.insertShotError = originalDependencies.insertShotError;
  mock.restoreAll();
  resetState();
});

test('processShotQueueJob sends intro media and plans with success logs', { concurrency: false }, async () => {
  await setupLoggerCapture();

  const shot: ShotRow = {
    id: 321,
    bot_slug: 'photo-bot',
    title: 'Oferta',
    copy: 'Oferta imperdível',
    media_url: 'https://example.com/photo.jpg',
    media_type: 'photo',
    scheduled_at: new Date('2024-10-01T10:00:00Z'),
    target: 'all_started',
  };

  const plans: ShotPlanRow[] = [
    { id: 1, shot_id: 321, name: 'Plano Ouro', price_cents: 19900, description: 'Acesso completo', sort_order: 1 },
    { id: 2, shot_id: 321, name: 'Plano Prata', price_cents: 9900, description: 'Conteúdo essencial', sort_order: 2 },
  ];

  currentScenario = { shot, plans };

  const sendChatActions: string[] = [];
  const photoCalls: any[] = [];
  const messageCalls: any[] = [];

  const fakeApi: FakeApi = {
    sendChatAction: async (_chatId, action) => {
      sendChatActions.push(action);
      return true;
    },
    sendPhoto: async (_chatId, url, options) => {
      photoCalls.push({ url, options });
      return { message_id: 10, url, options };
    },
    sendMessage: async (_chatId, text, options) => {
      messageCalls.push({ text, options });
      return { message_id: 20 + messageCalls.length, text, options };
    },
  };

  currentBotApi = { api: fakeApi };

  const job = createJob({ id: 999, shot_id: shot.id, bot_slug: shot.bot_slug, telegram_id: 998877 });
  lastJob = job;

  configureDependencies({ telegram_id: job.telegram_id ?? 0 });

  const fakeClient = {} as any;

  await processShotQueueJob(job, fakeClient);

  assert.deepEqual(sendChatActions, ['upload_photo']);
  assert.equal(photoCalls.length, 1);
  assert.equal(photoCalls[0].url, 'https://example.com/photo.jpg');
  assert.ok(photoCalls[0].options?.caption?.includes('Oferta'));
  assert.equal(photoCalls[0].options.parse_mode, 'HTML');
  assert.equal(photoCalls[0].options.disable_web_page_preview, true);
  assert.equal(messageCalls.length, 1);
  assert.match(messageCalls[0].text, /Plano Ouro<\/b> — R\$[\s\u00A0]199,00/);
  assert.match(messageCalls[0].text, /Plano Prata<\/b> — R\$[\s\u00A0]99,00/);
  assert.ok(messageCalls[0].options.reply_markup);

  assert.deepEqual(recordShotCalls, [
    {
      shot_id: 321,
      bot_slug: 'photo-bot',
      telegram_id: 998877,
      status: 'sent',
      error: null,
    },
  ]);

  assert.equal(markSuccessCalls.length, 1);
  assert.equal(markSuccessCalls[0].id, 999);
  assert.equal(markSuccessCalls[0].client, fakeClient);
  assert.equal(markProcessingCalls.length, 1);
  assert.equal(markProcessingCalls[0].id, job.id);
  assert.equal(markProcessingCalls[0].client, fakeClient);
  assert.equal(scheduleRetryCalls.length, 0);
  assert.equal(markErrorCalls.length, 0);
  assert.deepEqual(requestedBotSlugs, ['photo-bot']);

  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][SEND][INTRO] chatId=998877 media=photo captionUsed=yes copyChars=16 parts=0') &&
        msg.includes('corr="q:999|sh:321|tg:998877"')
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][SEND][PLANS] chatId=998877 plans=2') &&
        msg.includes('corr="q:999|sh:321|tg:998877"')
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][EVENT] name=shot_sent event_id=shs:321:998877') &&
        msg.includes('corr="q:999|sh:321|tg:998877"')
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][QUEUE][DONE] id=999 status=success attempts=1') &&
        msg.includes('corr="q:999|sh:321|tg:998877"')
    )
  );
  assert.equal(insertShotSentCalls.length, 1);
  assert.deepEqual(insertShotSentCalls[0], {
    shotId: 321,
    botSlug: 'photo-bot',
    telegramId: BigInt(998877),
    target: 'all_started',
  });
  assert.equal(insertShotErrorCalls.length, 0);
});

test('processShotQueueJob handles long copy without media and multiple plans', { concurrency: false }, async () => {
  await setupLoggerCapture();

  const longCopy = 'A'.repeat(4200);

  const shot: ShotRow = {
    id: 654,
    bot_slug: 'text-bot',
    title: 'Texto longo',
    copy: longCopy,
    media_url: null,
    media_type: null,
    scheduled_at: new Date('2024-12-24T21:00:00Z'),
    target: 'all_started',
  };

  const plans: ShotPlanRow[] = [
    { id: 10, shot_id: 654, name: 'Plano Alfa', price_cents: 4900, description: 'Primeiro plano', sort_order: 1 },
    { id: 11, shot_id: 654, name: 'Plano Beta', price_cents: 6900, description: 'Segundo plano', sort_order: 2 },
    { id: 12, shot_id: 654, name: 'Plano Gama', price_cents: 8900, description: 'Terceiro plano', sort_order: 3 },
  ];

  currentScenario = { shot, plans };

  const messageCalls: any[] = [];

  const fakeApi: FakeApi = {
    sendMessage: async (_chatId, text, options) => {
      messageCalls.push({ text, options });
      return { message_id: 40 + messageCalls.length, text, options };
    },
  };

  currentBotApi = { api: fakeApi };

  const job = createJob({ id: 888, shot_id: shot.id, bot_slug: shot.bot_slug, telegram_id: 123001 });
  lastJob = job;

  configureDependencies({ telegram_id: job.telegram_id ?? 0 });

  await processShotQueueJob(job, {} as any);

  assert.ok(messageCalls.length >= 3);
  assert.ok(messageCalls[0].text.length <= 4096);
  assert.ok(messageCalls[1].text.length <= 4096);
  assert.equal(messageCalls[0].options.parse_mode, 'HTML');
  assert.equal(messageCalls[1].options.parse_mode, 'HTML');
  assert.match(messageCalls.at(-1)?.text ?? '', /Plano Alfa/);
  assert.equal(messageCalls.at(-1)?.options.reply_markup?.inline_keyboard?.length ?? 0, 3);

  assert.deepEqual(recordShotCalls, [
    {
      shot_id: 654,
      bot_slug: 'text-bot',
      telegram_id: 123001,
      status: 'sent',
      error: null,
    },
  ]);

  assert.equal(markSuccessCalls.length, 1);
  assert.equal(markProcessingCalls.length, 1);
  assert.equal(markProcessingCalls[0].id, job.id);
  assert.equal(scheduleRetryCalls.length, 0);
  assert.equal(markErrorCalls.length, 0);
  assert.deepEqual(requestedBotSlugs, ['text-bot']);
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][SEND][PLANS] chatId=123001 plans=3') &&
        msg.includes('corr="q:888|sh:654|tg:123001"')
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][SEND][INTRO] chatId=123001 media=none captionUsed=no copyChars=4200 parts=') &&
        msg.includes('corr="q:888|sh:654|tg:123001"')
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][EVENT] name=shot_sent event_id=shs:654:123001') &&
        msg.includes('corr="q:888|sh:654|tg:123001"')
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][QUEUE][DONE] id=888 status=success attempts=1') &&
        msg.includes('corr="q:888|sh:654|tg:123001"')
    )
  );
  assert.equal(insertShotSentCalls.length, 1);
  assert.deepEqual(insertShotSentCalls[0], {
    shotId: 654,
    botSlug: 'text-bot',
    telegramId: BigInt(123001),
    target: 'all_started',
  });
  assert.equal(insertShotErrorCalls.length, 0);
});

test('processShotQueueJob sends only intro when no plans exist', { concurrency: false }, async () => {
  await setupLoggerCapture();

  const shot: ShotRow = {
    id: 777,
    bot_slug: 'video-bot',
    title: 'Vídeo especial',
    copy: 'Assista agora',
    media_url: 'https://example.com/video.mp4',
    media_type: 'video',
    scheduled_at: new Date('2025-01-01T00:00:00Z'),
    target: 'all_started',
  };

  currentScenario = { shot, plans: [] };

  const sentActions: any[] = [];
  const messageCalls: any[] = [];

  const fakeApi: FakeApi = {
    sendChatAction: async (_chatId, action) => {
      sentActions.push({ type: 'action', action });
      return true;
    },
    sendVideo: async (_chatId, url, options) => {
      sentActions.push({ type: 'video', url, options });
      return { message_id: 70, url, options };
    },
    sendMessage: async (_chatId, text, options) => {
      messageCalls.push({ text, options });
      return { message_id: 80 + messageCalls.length, text, options };
    },
  };

  currentBotApi = { api: fakeApi };

  const job = createJob({ id: 555, shot_id: shot.id, bot_slug: shot.bot_slug, telegram_id: 445566 });
  lastJob = job;

  configureDependencies({ telegram_id: job.telegram_id ?? 0 });

  await processShotQueueJob(job, {} as any);

  assert.deepEqual(
    sentActions.map((entry) => (entry.type === 'action' ? entry.action : entry.type)),
    ['upload_video', 'video']
  );
  assert.equal(messageCalls.length, 0);

  assert.deepEqual(recordShotCalls, [
    {
      shot_id: 777,
      bot_slug: 'video-bot',
      telegram_id: 445566,
      status: 'sent',
      error: null,
    },
  ]);

  assert.equal(markSuccessCalls.length, 1);
  assert.equal(markProcessingCalls.length, 1);
  assert.equal(markProcessingCalls[0].id, job.id);
  assert.equal(scheduleRetryCalls.length, 0);
  assert.equal(markErrorCalls.length, 0);
  assert.deepEqual(requestedBotSlugs, ['video-bot']);
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][SEND][PLANS] chatId=445566 plans=0') &&
        msg.includes('corr="q:555|sh:777|tg:445566"')
    )
  );
  assert.ok(logMessages.includes('[SHOTS][PLANS] none'));
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][EVENT] name=shot_sent event_id=shs:777:445566') &&
        msg.includes('corr="q:555|sh:777|tg:445566"')
    )
  );
  assert.ok(
    logMessages.some(
      (msg) =>
        msg.startsWith('[SHOTS][QUEUE][DONE] id=555 status=success attempts=1') &&
        msg.includes('corr="q:555|sh:777|tg:445566"')
    )
  );
  assert.equal(insertShotSentCalls.length, 1);
  assert.deepEqual(insertShotSentCalls[0], {
    shotId: 777,
    botSlug: 'video-bot',
    telegramId: BigInt(445566),
    target: 'all_started',
  });
  assert.equal(insertShotErrorCalls.length, 0);
});

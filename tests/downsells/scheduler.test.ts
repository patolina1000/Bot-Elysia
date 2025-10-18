import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { SchedulerDependencies } from '../../src/services/downsells/scheduler.js';
import type { BotDownsell } from '../../src/db/downsells.js';
import type {
  DownsellQueueJob,
  EnqueueDownsellParams,
} from '../../src/db/downsellsQueue.js';

function ensureEnv(): void {
  process.env.PORT ??= '8080';
  process.env.APP_BASE_URL ??= 'https://example.com';
  process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
  process.env.ENCRYPTION_KEY ??= '1234567890123456';
  process.env.ADMIN_API_TOKEN ??= 'admintoken123';
  process.env.NODE_ENV ??= 'development';
}

async function setupScheduler(overrides: Partial<SchedulerDependencies>) {
  ensureEnv();
  const modulePath = `../../src/services/downsells/scheduler.ts?test=${Math.random()}`;
  const module = await import(modulePath);
  const restore = module.__setSchedulerTestDependencies(overrides);
  return {
    scheduleDownsellsForMoment: module.scheduleDownsellsForMoment,
    restore,
  };
}

const baseDownsell: BotDownsell = {
  id: 42,
  bot_slug: 'test-bot',
  price_cents: 4990,
  copy: 'Buy now',
  button_intro_text: null,
  media_url: null,
  media_type: null,
  trigger: 'after_start',
  delay_minutes: 5,
  sort_order: null,
  active: true,
  plan_id: null,
  plan_label: null,
  plan_price_cents: null,
  plan_name: null,
  extra_plans: [],
  created_at: new Date(),
  updated_at: new Date(),
};

test.afterEach(() => {
  mock.restoreAll();
});

test('scheduleDownsellsForMoment skips when user has already paid', async () => {
  const hasPaidStub = mock.fn(async (..._args: any[]) => true);
  const listStub = mock.fn(async (..._args: any[]) => {
    throw new Error('should not list downsells when user has paid');
  });
  const alreadySentStub = mock.fn(async (..._args: any[]) => false);
  const enqueueStub = mock.fn(async (..._args: any[]) => {
    throw new Error('should not enqueue');
  });
  const funnelStub = mock.fn(async (..._args: any[]) => undefined);

  const { scheduleDownsellsForMoment, restore } = await setupScheduler({
    hasPaidTransactionForUser: async (botSlug, telegramId) =>
      hasPaidStub(botSlug, telegramId),
    listActiveDownsellsByMoment: async (botSlug, moment) => listStub(botSlug, moment),
    alreadySent: async (botSlug, downsellId, telegramId) =>
      alreadySentStub(botSlug, downsellId, telegramId),
    enqueueDownsell: async (params: EnqueueDownsellParams) => enqueueStub(params),
    createFunnelEvent: async (params) => {
      await funnelStub(params);
      return null;
    },
  });

  try {
    await scheduleDownsellsForMoment({
      botId: 'bot-1',
      botSlug: 'test-bot',
      telegramId: 123,
      moment: 'after_start',
    });
  } finally {
    restore();
  }

  assert.strictEqual(hasPaidStub.mock.calls.length, 1);
  assert.strictEqual(listStub.mock.calls.length, 0);
  assert.strictEqual(enqueueStub.mock.calls.length, 0);
  assert.strictEqual(funnelStub.mock.calls.length, 0);
});

test('scheduleDownsellsForMoment enqueues active downsells', async () => {
  const hasPaidStub = mock.fn(async (..._args: any[]) => false);
  const listStub = mock.fn(async (..._args: any[]) => [{ ...baseDownsell }]);
  const alreadySentStub = mock.fn(async (..._args: any[]) => false);
  const enqueueStub = mock.fn(async (params: EnqueueDownsellParams) => {
    const baseJob: DownsellQueueJob = {
      id: 1,
      bot_slug: params.bot_slug,
      downsell_id: params.downsell_id,
      telegram_id: params.telegram_id,
      deliver_at: params.deliver_at,
      status: 'scheduled',
      attempt_count: 0,
      last_error: null,
      transaction_id: null,
      external_id: null,
      sent_message_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    return baseJob;
  });
  const funnelStub = mock.fn(async (..._args: any[]) => undefined);

  const { scheduleDownsellsForMoment, restore } = await setupScheduler({
    hasPaidTransactionForUser: async (botSlug, telegramId) => hasPaidStub(botSlug, telegramId),
    listActiveDownsellsByMoment: async (botSlug, trigger) => listStub(botSlug, trigger),
    alreadySent: async (botSlug, downsellId, telegramId) =>
      alreadySentStub(botSlug, downsellId, telegramId),
    enqueueDownsell: async (params: EnqueueDownsellParams) => enqueueStub(params),
    createFunnelEvent: async (params) => {
      await funnelStub(params);
      return null;
    },
  });

  const before = Date.now();
  try {
    await scheduleDownsellsForMoment({
      botId: 'bot-1',
      botSlug: 'test-bot',
      telegramId: 123,
      moment: 'after_start',
    });
  } finally {
    restore();
  }
  const after = Date.now();

  assert.strictEqual(hasPaidStub.mock.calls.length, 1);
  assert.strictEqual(listStub.mock.calls.length, 1);
  assert.strictEqual(alreadySentStub.mock.calls.length, 1);
  assert.strictEqual(enqueueStub.mock.calls.length, 1);
  const firstEnqueueCall = enqueueStub.mock.calls[0];
  if (!firstEnqueueCall) {
    throw new Error('expected enqueueDownsell to be called');
  }
  const [enqueueArgs] = firstEnqueueCall.arguments as [EnqueueDownsellParams];
  const { bot_slug, downsell_id, telegram_id, deliver_at } = enqueueArgs;
  assert.strictEqual(bot_slug, 'test-bot');
  assert.strictEqual(downsell_id, baseDownsell.id);
  assert.strictEqual(telegram_id, 123);
  assert.ok(deliver_at instanceof Date);
  const minExpected = before + baseDownsell.delay_minutes * 60_000;
  const maxExpected = after + baseDownsell.delay_minutes * 60_000 + 1000;
  assert.ok(
    deliver_at.getTime() >= minExpected && deliver_at.getTime() <= maxExpected,
    'deliver_at should respect delay window'
  );
  assert.strictEqual(funnelStub.mock.calls.length, 1);
  const firstFunnelCall = funnelStub.mock.calls[0];
  if (!firstFunnelCall) {
    throw new Error('expected createFunnelEvent to be called');
  }
  const [eventPayload] = firstFunnelCall.arguments as unknown as [
    Parameters<SchedulerDependencies['createFunnelEvent']>[0]
  ];
  assert.strictEqual(eventPayload?.event, 'downsell_scheduled');
  assert.strictEqual(eventPayload?.payload_id, String(baseDownsell.id));
});

test('scheduleDownsellsForMoment skips downsells already sent', async () => {
  const hasPaidStub = mock.fn(async (..._args: any[]) => false);
  const listStub = mock.fn(async (..._args: any[]) => [{ ...baseDownsell }]);
  const alreadySentStub = mock.fn(async (..._args: any[]) => true);
  const enqueueStub = mock.fn(async (..._args: any[]) => {
    throw new Error('should not enqueue when already sent');
  });
  const funnelStub = mock.fn(async (..._args: any[]) => {
    throw new Error('should not create event when skipping');
  });

  const { scheduleDownsellsForMoment, restore } = await setupScheduler({
    hasPaidTransactionForUser: async (botSlug, telegramId) => hasPaidStub(botSlug, telegramId),
    listActiveDownsellsByMoment: async (botSlug, trigger) => listStub(botSlug, trigger),
    alreadySent: async (botSlug, downsellId, telegramId) =>
      alreadySentStub(botSlug, downsellId, telegramId),
    enqueueDownsell: async (params: EnqueueDownsellParams) => enqueueStub(params),
    createFunnelEvent: async (params) => {
      await funnelStub(params);
      return null;
    },
  });

  try {
    await scheduleDownsellsForMoment({
      botId: 'bot-1',
      botSlug: 'test-bot',
      telegramId: 123,
      moment: 'after_start',
    });
  } finally {
    restore();
  }

  assert.strictEqual(hasPaidStub.mock.calls.length, 1);
  assert.strictEqual(listStub.mock.calls.length, 1);
  assert.strictEqual(alreadySentStub.mock.calls.length, 1);
  assert.strictEqual(enqueueStub.mock.calls.length, 0);
  assert.strictEqual(funnelStub.mock.calls.length, 0);
});

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

type ShotRow = {
  id: number;
  bot_slug: string;
  target: string | null;
  scheduled_at: Date | string | null;
};

type FunnelEventRow = {
  telegram_id: number | null;
  event: string;
  payload_id?: string | null;
  meta?: { bot_slug?: string | null } | null;
};

type PayloadTrackingRow = {
  telegram_id: number;
  payload_id: string | null;
  bot_slug: string;
};

type ShotsQueueRow = {
  shot_id: number;
  bot_slug: string;
  telegram_id: string;
  status: string;
  attempts: number;
  scheduled_at: Date | null;
  next_retry_at: null;
};

type FakeDatabase = {
  shots: ShotRow[];
  funnelEvents: FunnelEventRow[];
  payloadTracking: PayloadTrackingRow[];
  shotsQueue: ShotsQueueRow[];
};

class FakePool {
  constructor(private readonly db: FakeDatabase) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    if (sql.includes('FROM shots')) {
      const shotId = params[0] as number;
      const row = this.db.shots.find((shot) => shot.id === shotId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM funnel_events')) {
      const botSlug = params[0] as string;
      const isAllStarted = sql.includes("fe.event = 'bot_start'");
      const allowedEvents = isAllStarted
        ? new Set(['bot_start'])
        : new Set(['pix_created', 'purchase']);

      const uniqueIds = new Set<string>();

      for (const event of this.db.funnelEvents) {
        if (event.telegram_id === null || event.telegram_id === undefined) {
          continue;
        }
        if (!allowedEvents.has(event.event)) {
          continue;
        }

        let slug: string | null | undefined = event.meta?.bot_slug ?? null;

        if (!slug) {
          for (const tracking of this.db.payloadTracking) {
            const payloadMatches =
              event.payload_id === null ||
              event.payload_id === undefined ||
              tracking.payload_id === event.payload_id;
            if (tracking.telegram_id === event.telegram_id && payloadMatches) {
              slug = tracking.bot_slug;
              break;
            }
          }
        }

        if (slug !== botSlug) {
          continue;
        }

        uniqueIds.add(event.telegram_id.toString());
      }

      const rows = Array.from(uniqueIds).map((telegramId) => ({ telegram_id: telegramId }));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('INSERT INTO shots_queue')) {
      const [shotId, botSlug, scheduledAt, telegramIds] = params as [
        number,
        string,
        Date | string | null | undefined,
        string[]
      ];

      let inserted = 0;
      const scheduledValue =
        scheduledAt instanceof Date
          ? new Date(scheduledAt.getTime())
          : scheduledAt
            ? new Date(scheduledAt)
            : null;

      for (const telegramIdRaw of telegramIds ?? []) {
        const telegramId = telegramIdRaw.toString();
        const exists = this.db.shotsQueue.some(
          (row) => row.shot_id === shotId && row.telegram_id === telegramId
        );
        if (exists) {
          continue;
        }

        this.db.shotsQueue.push({
          shot_id: shotId,
          bot_slug: botSlug,
          telegram_id: telegramId,
          status: 'pending',
          attempts: 0,
          scheduled_at: scheduledValue ? new Date(scheduledValue.getTime()) : null,
          next_retry_at: null,
        });
        inserted += 1;
      }

      return { rows: [], rowCount: inserted };
    }

    throw new Error(`Unexpected SQL query: ${sql}`);
  }
}

function ensureEnv(): void {
  process.env.PORT ??= '8080';
  process.env.APP_BASE_URL ??= 'https://example.com';
  process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
  process.env.ENCRYPTION_KEY ??= '1234567890123456';
  process.env.ADMIN_API_TOKEN ??= 'admintoken123';
  process.env.NODE_ENV ??= 'development';
}

let pool: typeof import('../../src/db/pool.js')['pool'];
let ShotsServiceClass: typeof import('../../src/services/ShotsService.js')['ShotsService'];
let metrics: typeof import('../../src/metrics.js')['metrics'];

test.before(async () => {
  ensureEnv();
  ({ pool } = await import('../../src/db/pool.js'));
  ({ ShotsService: ShotsServiceClass } = await import('../../src/services/ShotsService.js'));
  ({ metrics } = await import('../../src/metrics.js'));
});

test.afterEach(() => {
  mock.restoreAll();
});

function createTestContext() {
  const database: FakeDatabase = {
    shots: [],
    funnelEvents: [],
    payloadTracking: [],
    shotsQueue: [],
  };

  const fakePool = new FakePool(database);
  mock.method(pool, 'query', (sql: string, params?: unknown[]) => fakePool.query(sql, params));
  const metricsMock = mock.method(metrics, 'count', () => undefined);
  const service = new ShotsServiceClass();

  return { database, service, metricsMock };
}

test.describe('ShotsService.enqueueShotRecipients integration', { concurrency: false }, () => {
  test('all_started target enqueues exactly the bot audience', async () => {
    const { database, service, metricsMock } = createTestContext();

    database.shots.push({
      id: 101,
      bot_slug: 'bot-alpha',
      target: 'all_started',
      scheduled_at: new Date('2025-01-10T12:00:00Z'),
    });

    database.funnelEvents.push(
      { telegram_id: 1111, event: 'bot_start', meta: { bot_slug: 'bot-alpha' } },
      { telegram_id: 2222, event: 'bot_start', meta: { bot_slug: 'bot-alpha' } },
      { telegram_id: 3333, event: 'bot_start', meta: { bot_slug: 'bot-alpha' } },
      { telegram_id: 4444, event: 'bot_start', meta: { bot_slug: 'bot-beta' } },
      { telegram_id: null, event: 'bot_start', meta: { bot_slug: 'bot-alpha' } }
    );

    const result = await service.enqueueShotRecipients(101);

    assert.deepEqual(result, { candidates: 3, inserted: 3, duplicates: 0 });
    assert.equal(database.shotsQueue.length, 3);
    assert.deepEqual(
      database.shotsQueue.map((row) => Number.parseInt(row.telegram_id, 10)).sort(),
      [1111, 2222, 3333]
    );
    assert.ok(database.shotsQueue.every((row) => row.bot_slug === 'bot-alpha'));

    const metricCalls = metricsMock.mock.calls.map((call) => call.arguments);
    assert.deepEqual(metricCalls, [
      ['shots.enqueue.candidates', 3],
      ['shots.enqueue.inserted', 3],
      ['shots.enqueue.duplicates', 0],
    ]);
  });

  test('pix_generated target enqueues only pix_created and purchase events', async () => {
    const { database, service, metricsMock } = createTestContext();

    database.shots.push({
      id: 202,
      bot_slug: 'bot-pix',
      target: 'pix_generated',
      scheduled_at: new Date('2025-02-05T09:00:00Z'),
    });

    database.funnelEvents.push(
      { telegram_id: 5001, event: 'pix_created', meta: { bot_slug: 'bot-pix' } },
      { telegram_id: 5002, event: 'purchase', meta: { bot_slug: 'bot-pix' } },
      { telegram_id: 5003, event: 'pix_failed', meta: { bot_slug: 'bot-pix' } },
      { telegram_id: 5004, event: 'pix_created', meta: { bot_slug: 'other-bot' } },
      { telegram_id: 5005, event: 'pix_created', payload_id: 'abc', meta: null }
    );

    database.payloadTracking.push({ telegram_id: 5005, payload_id: 'abc', bot_slug: 'bot-pix' });

    const result = await service.enqueueShotRecipients(202);

    assert.deepEqual(result, { candidates: 3, inserted: 3, duplicates: 0 });
    assert.equal(database.shotsQueue.length, 3);
    assert.deepEqual(
      database.shotsQueue.map((row) => Number.parseInt(row.telegram_id, 10)).sort(),
      [5001, 5002, 5005]
    );

    const metricCalls = metricsMock.mock.calls.map((call) => call.arguments);
    assert.deepEqual(metricCalls, [
      ['shots.enqueue.candidates', 3],
      ['shots.enqueue.inserted', 3],
      ['shots.enqueue.duplicates', 0],
    ]);
  });

  test('repeated enqueue counts duplicates without inserting twice', async () => {
    const { database, service, metricsMock } = createTestContext();

    database.shots.push({
      id: 303,
      bot_slug: 'bot-repeat',
      target: 'all_started',
      scheduled_at: new Date('2025-03-01T08:30:00Z'),
    });

    database.funnelEvents.push(
      { telegram_id: 7001, event: 'bot_start', meta: { bot_slug: 'bot-repeat' } },
      { telegram_id: 7002, event: 'bot_start', meta: { bot_slug: 'bot-repeat' } }
    );

    const firstResult = await service.enqueueShotRecipients(303);
    assert.deepEqual(firstResult, { candidates: 2, inserted: 2, duplicates: 0 });
    assert.equal(database.shotsQueue.length, 2);
    assert.deepEqual(
      database.shotsQueue.map((row) => Number.parseInt(row.telegram_id, 10)).sort(),
      [7001, 7002]
    );

    const secondResult = await service.enqueueShotRecipients(303);
    assert.deepEqual(secondResult, { candidates: 2, inserted: 0, duplicates: 2 });
    assert.equal(database.shotsQueue.length, 2);

    const metricCalls = metricsMock.mock.calls.map((call) => call.arguments);
    assert.deepEqual(metricCalls, [
      ['shots.enqueue.candidates', 2],
      ['shots.enqueue.inserted', 2],
      ['shots.enqueue.duplicates', 0],
      ['shots.enqueue.candidates', 2],
      ['shots.enqueue.inserted', 0],
      ['shots.enqueue.duplicates', 2],
    ]);
  });
});

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

function ensureEnv(): void {
  process.env.PORT ??= '8080';
  process.env.APP_BASE_URL ??= 'https://example.com';
  process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
  process.env.ENCRYPTION_KEY ??= '1234567890123456';
  process.env.ADMIN_API_TOKEN ??= 'admintoken123';
  process.env.NODE_ENV ??= 'development';
}

let pool: typeof import('../../src/db/pool.js')['pool'];
let shotsService: typeof import('../../src/services/ShotsService.js')['shotsService'];

test.before(async () => {
  ensureEnv();
  const poolModule = await import('../../src/db/pool.js');
  pool = poolModule.pool;
  ({ shotsService } = await import('../../src/services/ShotsService.js'));
});

test.afterEach(() => {
  mock.restoreAll();
});

test('enqueueShotRecipients throws when shot is not found', async () => {
  mock.method(pool, 'query', async () => ({ rows: [] } as any));

  await assert.rejects(
    async () => {
      await shotsService.enqueueShotRecipients(123);
    },
    /Shot not found/
  );
});

test('enqueueShotRecipients throws for unsupported targets', async () => {
  mock.method(pool, 'query', async (sql: string) => {
    if (sql.includes('FROM shots')) {
      return {
        rows: [
          {
            id: 50,
            bot_slug: 'demo-bot',
            target: 'invalid',
            scheduled_at: new Date(),
          },
        ],
      } as any;
    }
    throw new Error('Unexpected query');
  });

  await assert.rejects(
    async () => {
      await shotsService.enqueueShotRecipients(50);
    },
    /Unsupported shot target/
  );
});

test('enqueueShotRecipients returns zero counts when there is no audience', async () => {
  const queryMock = mock.method(pool, 'query', async (sql: string) => {
    if (sql.includes('FROM shots')) {
      return {
        rows: [
          {
            id: 10,
            bot_slug: 'shots-bot',
            target: 'all_started',
            scheduled_at: new Date('2025-01-05T12:00:00Z'),
          },
        ],
      } as any;
    }

    if (sql.includes('FROM funnel_events')) {
      return { rows: [] } as any;
    }

    throw new Error('Unexpected query call');
  });

  const result = await shotsService.enqueueShotRecipients(10);

  assert.deepEqual(result, { candidates: 0, inserted: 0, duplicates: 0 });
  assert.strictEqual(queryMock.mock.calls.length, 2);
});

test('enqueueShotRecipients enqueues audience with conflict handling', async () => {
  const queryMock = mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM shots')) {
      return {
        rows: [
          {
            id: 77,
            bot_slug: 'shots-bot',
            target: 'all_started',
            scheduled_at: new Date('2025-02-01T00:00:00Z'),
          },
        ],
      } as any;
    }

    if (sql.includes('FROM funnel_events')) {
      return {
        rows: [
          { telegram_id: '111' },
          { telegram_id: 222 },
          { telegram_id: 333n },
        ],
      } as any;
    }

    if (sql.includes('INSERT INTO shots_queue')) {
      assert.ok(Array.isArray(params));
      assert.strictEqual(params[0], 77);
      assert.strictEqual(params[1], 'shots-bot');
      assert.ok(params[2] instanceof Date);
      assert.deepEqual(params[3], ['111', '222', '333']);
      return { rowCount: 2 } as any; // Simulate one duplicate
    }

    throw new Error('Unexpected query call');
  });

  const result = await shotsService.enqueueShotRecipients(77);

  assert.deepEqual(result, { candidates: 3, inserted: 2, duplicates: 1 });
  assert.strictEqual(queryMock.mock.calls.length, 3);
});

test('enqueueShotRecipients selects PIX audience when target is pix_created', async () => {
  const queryMock = mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM shots')) {
      return {
        rows: [
          {
            id: 88,
            bot_slug: 'pix-bot',
            target: 'pix_created',
            scheduled_at: '2025-03-10T10:00:00Z',
          },
        ],
      } as any;
    }

    if (sql.includes("fe.event_name IN ('pix_created', 'purchase')")) {
      return {
        rows: [{ telegram_id: 999 }],
      } as any;
    }

    if (sql.includes('INSERT INTO shots_queue')) {
      assert.ok(Array.isArray(params));
      assert.strictEqual(params[0], 88);
      assert.strictEqual(params[1], 'pix-bot');
      assert.ok(params[2] instanceof Date);
      assert.deepEqual(params[3], ['999']);
      return { rowCount: 1 } as any;
    }

    throw new Error('Unexpected query call');
  });

  const result = await shotsService.enqueueShotRecipients(88);

  assert.deepEqual(result, { candidates: 1, inserted: 1, duplicates: 0 });
  assert.strictEqual(queryMock.mock.calls.length, 3);
});

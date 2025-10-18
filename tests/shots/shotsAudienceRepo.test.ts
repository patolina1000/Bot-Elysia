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

let pool: typeof import('../../src/db/pool.ts')['pool'];
let logger: typeof import('../../src/logger.ts')['logger'];
let getTelegramIdsForAllStarted: typeof import('../../src/repositories/ShotsAudienceRepo.ts')['getTelegramIdsForAllStarted'];
let getTelegramIdsForPixGenerated: typeof import('../../src/repositories/ShotsAudienceRepo.ts')['getTelegramIdsForPixGenerated'];

test.before(async () => {
  ensureEnv();
  const poolModule = await import('../../src/db/pool.ts');
  pool = poolModule.pool;
  const loggerModule = await import('../../src/logger.ts');
  logger = loggerModule.logger;
  const repoModule = await import('../../src/repositories/ShotsAudienceRepo.ts');
  getTelegramIdsForAllStarted = repoModule.getTelegramIdsForAllStarted;
  getTelegramIdsForPixGenerated = repoModule.getTelegramIdsForPixGenerated;
});

test.afterEach(() => {
  mock.restoreAll();
});

test('getTelegramIdsForAllStarted returns an empty array when no rows are found', async () => {
  const queryMock = mock.method(pool, 'query', async () => ({ rows: [] } as any));

  const result = await getTelegramIdsForAllStarted('bot-slug');

  assert.deepEqual(result, []);
  assert.strictEqual(queryMock.mock.calls.length, 1);
});

test('getTelegramIdsForAllStarted maps telegram ids to bigint and skips nulls', async () => {
  mock.method(pool, 'query', async () => ({
    rows: [
      { telegram_id: '123456' },
      { telegram_id: 789012 },
      { telegram_id: 345678901234567890n },
      { telegram_id: null },
    ],
  }) as any);
  const debugMock = mock.method(logger, 'debug', () => undefined);

  const result = await getTelegramIdsForAllStarted('bot-slug');

  assert.deepEqual(result, [123456n, 789012n, 345678901234567890n]);
  assert.strictEqual(
    debugMock.mock.calls[0].arguments[0],
    '[SHOTS][AUDIENCE] target=all_started bot=bot-slug candidates=3 join="OR"'
  );
});

test('getTelegramIdsForAllStarted uses the expected SQL filter', async () => {
  const queryMock = mock.method(pool, 'query', async () => ({ rows: [] } as any));

  await getTelegramIdsForAllStarted('shots-bot');

  assert.strictEqual(queryMock.mock.calls.length, 1);
  const [sql, params] = queryMock.mock.calls[0].arguments;
  assert.ok(sql.includes("fe.event_name = 'bot_start'"));
  assert.ok(sql.includes("COALESCE(fe.meta->>'bot_slug', pt.bot_slug) = $1"));
  assert.ok(
    sql.includes('OR (fe.payload_id IS NOT NULL AND pt.payload_id = fe.payload_id)')
  );
  assert.ok(sql.includes('SELECT DISTINCT fe.telegram_id'));
  assert.deepEqual(params, ['shots-bot']);
});

test('getTelegramIdsForAllStarted returns ids when linked by telegram_id only', async () => {
  const queryMock = mock.method(pool, 'query', async (sql: string) => {
    assert.ok(sql.includes('LEFT JOIN payload_tracking pt'));
    return { rows: [{ telegram_id: '1001' }] } as any;
  });

  const result = await getTelegramIdsForAllStarted('shots-bot');

  assert.deepEqual(result, [1001n]);
  assert.strictEqual(queryMock.mock.calls.length, 1);
});

test('getTelegramIdsForAllStarted returns ids when linked by payload_id only', async () => {
  const queryMock = mock.method(pool, 'query', async (sql: string) => {
    if (sql.includes('OR (fe.payload_id IS NOT NULL AND pt.payload_id = fe.payload_id)')) {
      return { rows: [{ telegram_id: '2002' }] } as any;
    }
    return { rows: [] } as any;
  });

  const result = await getTelegramIdsForAllStarted('shots-bot');

  assert.deepEqual(result, [2002n]);
  assert.strictEqual(queryMock.mock.calls.length, 1);
});

test('getTelegramIdsForAllStarted keeps telegram ids distinct when both keys match', async () => {
  const queryMock = mock.method(pool, 'query', async (sql: string) => {
    assert.ok(sql.includes('SELECT DISTINCT fe.telegram_id'));
    return { rows: [{ telegram_id: '3003' }] } as any;
  });

  const result = await getTelegramIdsForAllStarted('shots-bot');

  assert.deepEqual(result, [3003n]);
  assert.strictEqual(queryMock.mock.calls.length, 1);
});

test('getTelegramIdsForPixGenerated returns an empty array when no rows are found', async () => {
  const queryMock = mock.method(pool, 'query', async () => ({ rows: [] } as any));

  const result = await getTelegramIdsForPixGenerated('bot-slug');

  assert.deepEqual(result, []);
  assert.strictEqual(queryMock.mock.calls.length, 1);
});

test('getTelegramIdsForPixGenerated maps telegram ids to bigint and skips nulls', async () => {
  mock.method(pool, 'query', async () => ({
    rows: [
      { telegram_id: '111' },
      { telegram_id: 222 },
      { telegram_id: 333n },
      { telegram_id: undefined },
    ],
  }) as any);
  const debugMock = mock.method(logger, 'debug', () => undefined);

  const result = await getTelegramIdsForPixGenerated('bot-slug');

  assert.deepEqual(result, [111n, 222n, 333n]);
  assert.strictEqual(
    debugMock.mock.calls[0].arguments[0],
    '[SHOTS][AUDIENCE] target=pix_generated bot=bot-slug candidates=3 join="OR"'
  );
});

test('getTelegramIdsForPixGenerated uses the expected SQL filter', async () => {
  const queryMock = mock.method(pool, 'query', async () => ({ rows: [] } as any));

  await getTelegramIdsForPixGenerated('shots-bot');

  assert.strictEqual(queryMock.mock.calls.length, 1);
  const [sql, params] = queryMock.mock.calls[0].arguments;
  assert.ok(sql.includes("fe.event_name IN ('pix_created', 'purchase')"));
  assert.ok(sql.includes("COALESCE(fe.meta->>'bot_slug', pt.bot_slug) = $1"));
  assert.ok(
    sql.includes('OR (fe.payload_id IS NOT NULL AND pt.payload_id = fe.payload_id)')
  );
  assert.ok(sql.includes('SELECT DISTINCT fe.telegram_id'));
  assert.deepEqual(params, ['shots-bot']);
});

test('getTelegramIdsForPixGenerated returns ids when linked by telegram_id only', async () => {
  const queryMock = mock.method(pool, 'query', async (sql: string) => {
    assert.ok(sql.includes('LEFT JOIN payload_tracking pt'));
    return { rows: [{ telegram_id: '4004' }] } as any;
  });

  const result = await getTelegramIdsForPixGenerated('shots-bot');

  assert.deepEqual(result, [4004n]);
  assert.strictEqual(queryMock.mock.calls.length, 1);
});

test('getTelegramIdsForPixGenerated returns ids when linked by payload_id only', async () => {
  const queryMock = mock.method(pool, 'query', async (sql: string) => {
    if (sql.includes('OR (fe.payload_id IS NOT NULL AND pt.payload_id = fe.payload_id)')) {
      return { rows: [{ telegram_id: '5005' }] } as any;
    }
    return { rows: [] } as any;
  });

  const result = await getTelegramIdsForPixGenerated('shots-bot');

  assert.deepEqual(result, [5005n]);
  assert.strictEqual(queryMock.mock.calls.length, 1);
});

test('getTelegramIdsForPixGenerated keeps telegram ids distinct when both keys match', async () => {
  const queryMock = mock.method(pool, 'query', async (sql: string) => {
    assert.ok(sql.includes('SELECT DISTINCT fe.telegram_id'));
    return { rows: [{ telegram_id: '6006' }] } as any;
  });

  const result = await getTelegramIdsForPixGenerated('shots-bot');

  assert.deepEqual(result, [6006n]);
  assert.strictEqual(queryMock.mock.calls.length, 1);
});

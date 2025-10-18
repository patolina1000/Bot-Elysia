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
let logger: typeof import('../../src/logger.js')['logger'];
let getTelegramIdsForAllStarted: typeof import('../../src/repositories/ShotsAudienceRepo.js')['getTelegramIdsForAllStarted'];
let getTelegramIdsForPixGenerated: typeof import('../../src/repositories/ShotsAudienceRepo.js')['getTelegramIdsForPixGenerated'];

test.before(async () => {
  ensureEnv();
  const poolModule = await import('../../src/db/pool.js');
  pool = poolModule.pool;
  const loggerModule = await import('../../src/logger.js');
  logger = loggerModule.logger;
  const repoModule = await import('../../src/repositories/ShotsAudienceRepo.js');
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
  const firstDebugCall = debugMock.mock.calls[0];
  if (!firstDebugCall) {
    throw new Error('expected debug log for all_started');
  }
  const [debugMessage] = firstDebugCall.arguments as [string];
  assert.strictEqual(
    debugMessage,
    '[SHOTS][AUDIENCE] target=all_started bot=bot-slug candidates=3 join="OR"'
  );
});

test('getTelegramIdsForAllStarted uses the expected SQL filter', async () => {
  const queryMock = mock.method(pool, 'query', async () => ({ rows: [] } as any));

  await getTelegramIdsForAllStarted('shots-bot');

  assert.strictEqual(queryMock.mock.calls.length, 1);
  const firstCall = queryMock.mock.calls[0];
  if (!firstCall) {
    throw new Error('expected SQL call for all_started filter');
  }
  const [sql, params] = firstCall.arguments as unknown as [string, any[]];
  assert.ok(sql.includes("fe.event = 'bot_start'"));
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
  const firstDebugCall = debugMock.mock.calls[0];
  if (!firstDebugCall) {
    throw new Error('expected debug log for pix_generated');
  }
  const [debugMessage] = firstDebugCall.arguments as [string];
  assert.strictEqual(
    debugMessage,
    '[SHOTS][AUDIENCE] target=pix_generated bot=bot-slug candidates=3 join="OR"'
  );
});

test('getTelegramIdsForPixGenerated uses the expected SQL filter', async () => {
  const queryMock = mock.method(pool, 'query', async () => ({ rows: [] } as any));

  await getTelegramIdsForPixGenerated('shots-bot');

  assert.strictEqual(queryMock.mock.calls.length, 1);
  const firstCall = queryMock.mock.calls[0];
  if (!firstCall) {
    throw new Error('expected SQL call for pix_generated filter');
  }
  const [sql, params] = firstCall.arguments as unknown as [string, any[]];
  assert.ok(sql.includes("fe.event IN ('pix_created', 'purchase')"));
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

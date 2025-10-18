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
let getTelegramIdsForAllStarted: typeof import('../../src/repositories/ShotsAudienceRepo.ts')['getTelegramIdsForAllStarted'];
let getTelegramIdsForPixGenerated: typeof import('../../src/repositories/ShotsAudienceRepo.ts')['getTelegramIdsForPixGenerated'];

test.before(async () => {
  ensureEnv();
  const poolModule = await import('../../src/db/pool.ts');
  pool = poolModule.pool;
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

  const result = await getTelegramIdsForAllStarted('bot-slug');

  assert.deepEqual(result, [123456n, 789012n, 345678901234567890n]);
});

test('getTelegramIdsForAllStarted uses the expected SQL filter', async () => {
  const queryMock = mock.method(pool, 'query', async () => ({ rows: [] } as any));

  await getTelegramIdsForAllStarted('shots-bot');

  assert.strictEqual(queryMock.mock.calls.length, 1);
  const [sql, params] = queryMock.mock.calls[0].arguments;
  assert.ok(sql.includes("fe.event_name = 'bot_start'"));
  assert.ok(sql.includes("COALESCE(fe.meta->>'bot_slug', pt.bot_slug) = $1"));
  assert.deepEqual(params, ['shots-bot']);
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

  const result = await getTelegramIdsForPixGenerated('bot-slug');

  assert.deepEqual(result, [111n, 222n, 333n]);
});

test('getTelegramIdsForPixGenerated uses the expected SQL filter', async () => {
  const queryMock = mock.method(pool, 'query', async () => ({ rows: [] } as any));

  await getTelegramIdsForPixGenerated('shots-bot');

  assert.strictEqual(queryMock.mock.calls.length, 1);
  const [sql, params] = queryMock.mock.calls[0].arguments;
  assert.ok(sql.includes("fe.event_name IN ('pix_created','purchase')"));
  assert.ok(sql.includes("COALESCE(fe.meta->>'bot_slug', pt.bot_slug) = $1"));
  assert.deepEqual(params, ['shots-bot']);
});

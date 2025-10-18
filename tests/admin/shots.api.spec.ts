import assert from 'node:assert/strict';
import express from 'express';
import test, { mock } from 'node:test';
import supertest from 'supertest';

declare module globalThis {
  // eslint-disable-next-line no-var
  var fetch: typeof fetch;
}

process.env.PORT ??= '8080';
process.env.APP_BASE_URL ??= 'https://example.com';
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
process.env.ENCRYPTION_KEY ??= '1234567890123456';
process.env.ADMIN_API_TOKEN = 'admin-test-token';
process.env.NODE_ENV ??= 'development';

let adminShotsRouter: import('express').Router;
let pool: typeof import('../../src/db/pool.js')['pool'];
let shotsService: typeof import('../../src/services/ShotsService.js')['shotsService'];

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_TOKEN}` };

interface ShotRecord {
  id: number;
  bot_slug: string;
  title: string | null;
  copy: string | null;
  media_url: string | null;
  media_type: string | null;
  target: string;
  scheduled_at: Date | null;
  created_at: Date;
}

interface PlanRecord {
  id: number;
  shot_id: number;
  name: string;
  price_cents: number;
  description: string | null;
  sort_order: number;
}

interface QueueRecord {
  shot_id: number;
  status: string;
}

interface FakeDatabase {
  bots: string[];
  shots: ShotRecord[];
  shotPlans: PlanRecord[];
  shotsQueue: QueueRecord[];
  nextShotId: number;
  nextPlanId: number;
}

test.before(async () => {
  ({ adminShotsRouter } = await import('../../src/api/admin/shots.routes.js'));
  ({ pool } = await import('../../src/db/pool.js'));
  ({ shotsService } = await import('../../src/services/ShotsService.js'));
});

test.afterEach(() => {
  mock.restoreAll();
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', adminShotsRouter);
  return app;
}

function createDatabase(): FakeDatabase {
  return {
    bots: ['bot-alpha', 'bot-beta'],
    shots: [],
    shotPlans: [],
    shotsQueue: [],
    nextShotId: 1,
    nextPlanId: 1,
  };
}

function cloneShot(shot: ShotRecord): ShotRecord {
  return {
    ...shot,
    scheduled_at: shot.scheduled_at ? new Date(shot.scheduled_at) : null,
    created_at: new Date(shot.created_at),
  };
}

function clonePlan(plan: PlanRecord): PlanRecord {
  return { ...plan };
}

async function handleQuery(db: FakeDatabase, sql: string, params: any[] = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

  if (normalized.startsWith('select 1 from bots')) {
    const slug = String(params[0]);
    const exists = db.bots.includes(slug);
    return { rows: exists ? [{ '?column?': 1 }] : [], rowCount: exists ? 1 : 0 };
  }

  if (normalized.startsWith('insert into shots ')) {
    const [botSlug, title, copy, mediaUrl, mediaType, target, scheduledAt] = params;
    const record: ShotRecord = {
      id: db.nextShotId++,
      bot_slug: String(botSlug),
      title: title ?? null,
      copy: copy ?? null,
      media_url: mediaUrl ?? null,
      media_type: mediaType ?? null,
      target: target ?? 'all_started',
      scheduled_at: scheduledAt ? new Date(scheduledAt) : null,
      created_at: new Date(),
    };
    db.shots.push(record);
    return { rows: [cloneShot(record)], rowCount: 1 };
  }

  if (normalized.startsWith('select id, bot_slug, title, copy, media_url, media_type, target, scheduled_at, created_at from shots where id = $1')) {
    const shotId = Number(params[0]);
    const shot = db.shots.find((item) => item.id === shotId);
    return shot ? { rows: [cloneShot(shot)], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  if (normalized.startsWith('select id, shot_id, name, price_cents, description, sort_order from shot_plans where shot_id = $1')) {
    const shotId = Number(params[0]);
    const plans = db.shotPlans
      .filter((plan) => plan.shot_id === shotId)
      .sort((a, b) => (a.sort_order - b.sort_order) || a.id - b.id)
      .map(clonePlan);
    return { rows: plans, rowCount: plans.length };
  }

  if (normalized.startsWith('select id, shot_id, name, price_cents, description, sort_order from shot_plans where id = $1')) {
    const planId = Number(params[0]);
    const plan = db.shotPlans.find((item) => item.id === planId);
    return plan ? { rows: [clonePlan(plan)], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  if (normalized.startsWith('select coalesce(max(sort_order), -1) + 1 as next from shot_plans')) {
    const shotId = Number(params[0]);
    const max = db.shotPlans.filter((plan) => plan.shot_id === shotId).reduce((acc, plan) => Math.max(acc, plan.sort_order), -1);
    return { rows: [{ next: max + 1 }], rowCount: 1 };
  }

  if (normalized.startsWith('insert into shot_plans')) {
    const [shotId, name, priceCents, description, sortOrder] = params;
    const record: PlanRecord = {
      id: db.nextPlanId++,
      shot_id: Number(shotId),
      name: String(name),
      price_cents: Number(priceCents),
      description: description ?? null,
      sort_order: Number(sortOrder),
    };
    db.shotPlans.push(record);
    return { rows: [clonePlan(record)], rowCount: 1 };
  }

  if (normalized.startsWith('update shot_plans set')) {
    const shotId = Number(params[params.length - 2]);
    const planId = Number(params[params.length - 1]);
    const plan = db.shotPlans.find((item) => item.shot_id === shotId && item.id === planId);
    if (!plan) {
      return { rows: [], rowCount: 0 };
    }
    const setPart = sql.slice(sql.toLowerCase().indexOf('set') + 3, sql.toLowerCase().indexOf('where')).trim();
    const assignments = setPart.split(',').map((chunk) => chunk.trim().split('=')[0].trim());
    assignments.forEach((column, index) => {
      const value = params[index];
      if (column === 'name') plan.name = value ?? plan.name;
      if (column === 'price_cents') plan.price_cents = Number(value);
      if (column === 'description') plan.description = value ?? null;
      if (column === 'sort_order') plan.sort_order = Number(value);
    });
    return { rows: [clonePlan(plan)], rowCount: 1 };
  }

  if (normalized.startsWith('delete from shot_plans')) {
    const shotId = Number(params[0]);
    const planId = Number(params[1]);
    const initial = db.shotPlans.length;
    db.shotPlans = db.shotPlans.filter((plan) => !(plan.shot_id === shotId && plan.id === planId));
    return { rows: [], rowCount: initial === db.shotPlans.length ? 0 : 1 };
  }

  if (normalized.startsWith('update shot_plans set sort_order = $1')) {
    const [sortOrder, shotId, planId] = params.map(Number);
    const plan = db.shotPlans.find((item) => item.shot_id === shotId && item.id === planId);
    if (plan) {
      plan.sort_order = sortOrder;
    }
    return { rows: plan ? [clonePlan(plan)] : [], rowCount: plan ? 1 : 0 };
  }

  if (normalized.startsWith('update shots set')) {
    const shotId = Number(params[params.length - 1]);
    const shot = db.shots.find((item) => item.id === shotId);
    if (!shot) {
      return { rows: [], rowCount: 0 };
    }
    const setPart = sql.slice(sql.toLowerCase().indexOf('set') + 3, sql.toLowerCase().indexOf('where')).trim();
    const assignments = setPart.split(',').map((chunk) => chunk.trim().split('=')[0].trim());
    assignments.forEach((column, index) => {
      const value = params[index];
      switch (column) {
        case 'bot_slug':
          shot.bot_slug = String(value);
          break;
        case 'title':
          shot.title = value ?? null;
          break;
        case 'copy':
          shot.copy = value ?? null;
          break;
        case 'media_url':
          shot.media_url = value ?? null;
          break;
        case 'media_type':
          shot.media_type = value ?? null;
          break;
        case 'target':
          shot.target = value ?? shot.target;
          break;
        case 'scheduled_at':
          shot.scheduled_at = value ? new Date(value) : null;
          break;
        default:
          break;
      }
    });
    return { rows: [cloneShot(shot)], rowCount: 1 };
  }

  if (normalized.startsWith('delete from shots')) {
    const shotId = Number(params[0]);
    const initial = db.shots.length;
    db.shots = db.shots.filter((shot) => shot.id !== shotId);
    db.shotPlans = db.shotPlans.filter((plan) => plan.shot_id !== shotId);
    db.shotsQueue = db.shotsQueue.filter((queue) => queue.shot_id !== shotId);
    return { rows: [], rowCount: initial === db.shots.length ? 0 : 1 };
  }

  if (normalized.startsWith('select id, bot_slug, title, copy, media_url, media_type, target, scheduled_at, created_at from shots where bot_slug = $1')) {
    const botSlug = String(params[0]);
    const hasSearch = params.length === 4;
    const searchValue = hasSearch ? String(params[1]).replace(/%/g, '').toLowerCase() : null;
    const limit = Number(params[hasSearch ? 2 : 1]);
    const offset = Number(params[hasSearch ? 3 : 2]);

    let filtered = db.shots.filter((shot) => shot.bot_slug === botSlug);
    if (searchValue) {
      filtered = filtered.filter((shot) => {
        const title = (shot.title ?? '').toLowerCase();
        const copy = (shot.copy ?? '').toLowerCase();
        return title.includes(searchValue) || copy.includes(searchValue);
      });
    }

    filtered = filtered.sort((a, b) => {
      const createdDiff = b.created_at.getTime() - a.created_at.getTime();
      if (createdDiff !== 0) {
        return createdDiff;
      }
      return b.id - a.id;
    });

    const sliced = filtered.slice(offset, offset + limit).map(cloneShot);
    return { rows: sliced, rowCount: sliced.length };
  }

  if (normalized.startsWith('select count(*) as total from shots where bot_slug = $1')) {
    const botSlug = String(params[0]);
    const hasSearch = params.length === 2;
    const searchValue = hasSearch ? String(params[1]).replace(/%/g, '').toLowerCase() : null;
    let filtered = db.shots.filter((shot) => shot.bot_slug === botSlug);
    if (searchValue) {
      filtered = filtered.filter((shot) => {
        const title = (shot.title ?? '').toLowerCase();
        const copy = (shot.copy ?? '').toLowerCase();
        return title.includes(searchValue) || copy.includes(searchValue);
      });
    }
    return { rows: [{ total: filtered.length }], rowCount: 1 };
  }

  if (normalized.startsWith('select shot_id, status, count(*) as count from shots_queue where shot_id = any')) {
    const shotIds = Array.isArray(params[0]) ? params[0].map(Number) : [];
    const rows = shotIds.flatMap((shotId) => {
      const grouped = new Map<string, number>();
      for (const item of db.shotsQueue.filter((queue) => queue.shot_id === shotId)) {
        grouped.set(item.status, (grouped.get(item.status) ?? 0) + 1);
      }
      return Array.from(grouped.entries()).map(([status, count]) => ({ shot_id: shotId, status, count }));
    });
    return { rows, rowCount: rows.length };
  }

  if (normalized.startsWith('select status, count(*) as count from shots_queue where shot_id = $1')) {
    const shotId = Number(params[0]);
    const grouped = new Map<string, number>();
    for (const item of db.shotsQueue.filter((queue) => queue.shot_id === shotId)) {
      grouped.set(item.status, (grouped.get(item.status) ?? 0) + 1);
    }
    const rows = Array.from(grouped.entries()).map(([status, count]) => ({ status, count }));
    return { rows, rowCount: rows.length };
  }

  if (normalized.startsWith('select 1 from shots_queue where shot_id = $1 and status in')) {
    const shotId = Number(params[0]);
    const exists = db.shotsQueue.some((queue) => queue.shot_id === shotId && (queue.status === 'success' || queue.status === 'sent'));
    return { rows: exists ? [{ '?column?': 1 }] : [], rowCount: exists ? 1 : 0 };
  }

  if (normalized.startsWith('select 1 from shots_queue where shot_id = $1')) {
    const shotId = Number(params[0]);
    const exists = db.shotsQueue.some((queue) => queue.shot_id === shotId);
    return { rows: exists ? [{ '?column?': 1 }] : [], rowCount: exists ? 1 : 0 };
  }

  throw new Error(`Unhandled query: ${sql}`);
}

function setupTest() {
  const database = createDatabase();
  const queryMock = mock.method(pool, 'query', (sql: string, params?: any[]) => handleQuery(database, sql, params));
  const app = createApp();
  return { app, database, restore: () => queryMock.mock.restore() };
}

test('requires admin auth token', async () => {
  const { app, restore } = setupTest();
  try {
    const response = await supertest(app).get('/api/shots');
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'Missing or invalid authorization header');
  } finally {
    restore();
  }
});

test('creates shot and lists with aggregated stats', async () => {
  const { app, database, restore } = setupTest();
  try {
    const createResponse = await supertest(app)
      .post('/api/shots')
      .set(AUTH_HEADER)
      .send({
        bot_slug: 'bot-alpha',
        title: 'Intro Offer',
        copy: 'Hello world',
        target: 'all_started',
        media_type: 'none',
      });
    assert.equal(createResponse.status, 201);
    assert.equal(database.shots.length, 1);

    database.shotsQueue.push(
      { shot_id: 1, status: 'pending' },
      { shot_id: 1, status: 'processing' },
      { shot_id: 1, status: 'success' },
      { shot_id: 1, status: 'error' }
    );

    const listResponse = await supertest(app)
      .get('/api/shots')
      .set(AUTH_HEADER)
      .query({ bot_slug: 'bot-alpha' });

    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.body.total, 1);
    assert.equal(listResponse.body.items.length, 1);
    const stats = listResponse.body.items[0].queue_stats;
    assert.deepEqual(stats, { queued: 1, processing: 1, success: 1, error: 1 });
  } finally {
    restore();
  }
});

test('fetches shot details and updates copy and media', async () => {
  const { app, database, restore } = setupTest();
  try {
    const shot: ShotRecord = {
      id: database.nextShotId++,
      bot_slug: 'bot-alpha',
      title: 'Old title',
      copy: 'Old copy',
      media_url: null,
      media_type: 'none',
      target: 'all_started',
      scheduled_at: null,
      created_at: new Date('2025-01-01T00:00:00Z'),
    };
    database.shots.push(shot);
    database.shotPlans.push({
      id: database.nextPlanId++,
      shot_id: shot.id,
      name: 'Plan A',
      price_cents: 1000,
      description: 'Desc',
      sort_order: 0,
    });

    const getResponse = await supertest(app).get(`/api/shots/${shot.id}`).set(AUTH_HEADER);
    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.plans.length, 1);

    const updateResponse = await supertest(app)
      .put(`/api/shots/${shot.id}`)
      .set(AUTH_HEADER)
      .send({ copy: 'New copy', media_type: 'photo', media_url: 'https://example.com/photo.jpg' });
    assert.equal(updateResponse.status, 200);
    assert.equal(database.shots[0].copy, 'New copy');
    assert.equal(database.shots[0].media_type, 'photo');
    assert.equal(database.shots[0].media_url, 'https://example.com/photo.jpg');
  } finally {
    restore();
  }
});

test('blocks bot_slug change when queue exists and allows otherwise', async () => {
  const { app, database, restore } = setupTest();
  try {
    const shot: ShotRecord = {
      id: database.nextShotId++,
      bot_slug: 'bot-alpha',
      title: null,
      copy: 'Copy',
      media_url: null,
      media_type: 'none',
      target: 'all_started',
      scheduled_at: null,
      created_at: new Date(),
    };
    database.shots.push(shot);
    database.shotsQueue.push({ shot_id: shot.id, status: 'pending' });

    const conflictResponse = await supertest(app)
      .put(`/api/shots/${shot.id}`)
      .set(AUTH_HEADER)
      .send({ bot_slug: 'bot-beta' });
    assert.equal(conflictResponse.status, 409);

    database.shotsQueue = [];
    const successResponse = await supertest(app)
      .put(`/api/shots/${shot.id}`)
      .set(AUTH_HEADER)
      .send({ bot_slug: 'bot-beta' });
    assert.equal(successResponse.status, 200);
    assert.equal(database.shots[0].bot_slug, 'bot-beta');
  } finally {
    restore();
  }
});

test('delete shot respects successful queue guard', async () => {
  const { app, database, restore } = setupTest();
  try {
    const shot: ShotRecord = {
      id: database.nextShotId++,
      bot_slug: 'bot-alpha',
      title: null,
      copy: 'Copy',
      media_url: null,
      media_type: 'none',
      target: 'all_started',
      scheduled_at: null,
      created_at: new Date(),
    };
    database.shots.push(shot);
    database.shotsQueue.push({ shot_id: shot.id, status: 'success' });

    const conflictResponse = await supertest(app).delete(`/api/shots/${shot.id}`).set(AUTH_HEADER);
    assert.equal(conflictResponse.status, 409);

    database.shotsQueue = [];
    const successResponse = await supertest(app).delete(`/api/shots/${shot.id}`).set(AUTH_HEADER);
    assert.equal(successResponse.status, 204);
    assert.equal(database.shots.length, 0);
  } finally {
    restore();
  }
});

test('plan CRUD and reorder lifecycle', async () => {
  const { app, database, restore } = setupTest();
  try {
    const shot: ShotRecord = {
      id: database.nextShotId++,
      bot_slug: 'bot-alpha',
      title: null,
      copy: 'Copy',
      media_url: null,
      media_type: 'none',
      target: 'all_started',
      scheduled_at: null,
      created_at: new Date(),
    };
    database.shots.push(shot);

    const createPlan = await supertest(app)
      .post(`/api/shots/${shot.id}/plans`)
      .set(AUTH_HEADER)
      .send({ name: 'Plan 1', price_cents: 5000, description: 'Desc 1' });
    assert.equal(createPlan.status, 201);
    const planId = createPlan.body.plan.id;

    const updatePlan = await supertest(app)
      .put(`/api/shots/${shot.id}/plans/${planId}`)
      .set(AUTH_HEADER)
      .send({ price_cents: 7000, description: 'Updated' });
    assert.equal(updatePlan.status, 200);
    assert.equal(database.shotPlans[0].price_cents, 7000);

    const plan2 = await supertest(app)
      .post(`/api/shots/${shot.id}/plans`)
      .set(AUTH_HEADER)
      .send({ name: 'Plan 2', price_cents: 3000 });
    assert.equal(plan2.status, 201);

    const reorder = await supertest(app)
      .post(`/api/shots/${shot.id}/plans/reorder`)
      .set(AUTH_HEADER)
      .send({ order: database.shotPlans.map((plan) => plan.id).reverse() });
    assert.equal(reorder.status, 200);
    assert.deepEqual(
      database.shotPlans
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((plan) => plan.id),
      reorder.body.plans.map((plan: PlanRecord) => plan.id)
    );

    const deletePlan = await supertest(app)
      .delete(`/api/shots/${shot.id}/plans/${planId}`)
      .set(AUTH_HEADER);
    assert.equal(deletePlan.status, 204);
    assert.equal(database.shotPlans.some((plan) => plan.id === planId), false);
  } finally {
    restore();
  }
});

test('trigger now enqueues and schedule validates future date', async () => {
  const { app, database, restore } = setupTest();
  try {
    const shot: ShotRecord = {
      id: database.nextShotId++,
      bot_slug: 'bot-alpha',
      title: null,
      copy: 'Copy',
      media_url: null,
      media_type: 'none',
      target: 'all_started',
      scheduled_at: null,
      created_at: new Date(),
    };
    database.shots.push(shot);

    const enqueueMock = mock.method(shotsService, 'enqueueShotRecipients', async () => ({
      candidates: 5,
      inserted: 4,
      duplicates: 1,
    }));

    const nowResponse = await supertest(app)
      .post(`/api/shots/${shot.id}/trigger`)
      .set(AUTH_HEADER)
      .send({ mode: 'now' });
    assert.equal(nowResponse.status, 200);
    assert.equal(enqueueMock.mock.callCount(), 1);
    assert.equal(nowResponse.body.stats.inserted, 4);
    assert.ok(database.shots[0].scheduled_at instanceof Date);

    const futureDate = new Date(Date.now() + 60_000).toISOString();
    const scheduleResponse = await supertest(app)
      .post(`/api/shots/${shot.id}/trigger`)
      .set(AUTH_HEADER)
      .send({ mode: 'schedule', scheduled_at: futureDate });
    assert.equal(scheduleResponse.status, 200);
    assert.equal(scheduleResponse.body.mode, 'schedule');
    assert.equal(enqueueMock.mock.callCount(), 1);

    const pastResponse = await supertest(app)
      .post(`/api/shots/${shot.id}/trigger`)
      .set(AUTH_HEADER)
      .send({ mode: 'schedule', scheduled_at: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(pastResponse.status, 400);
  } finally {
    restore();
  }
});

test('stats endpoint aggregates queue statuses', async () => {
  const { app, database, restore } = setupTest();
  try {
    const shot: ShotRecord = {
      id: database.nextShotId++,
      bot_slug: 'bot-alpha',
      title: null,
      copy: 'Copy',
      media_url: null,
      media_type: 'none',
      target: 'all_started',
      scheduled_at: null,
      created_at: new Date(),
    };
    database.shots.push(shot);
    database.shotsQueue.push(
      { shot_id: shot.id, status: 'pending' },
      { shot_id: shot.id, status: 'processing' },
      { shot_id: shot.id, status: 'sent' },
      { shot_id: shot.id, status: 'skipped' }
    );

    const response = await supertest(app).get(`/api/shots/${shot.id}/stats`).set(AUTH_HEADER);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.stats, { queued: 1, processing: 1, success: 1, error: 1 });
  } finally {
    restore();
  }
});

test('preview builds media, caption and keyboard summary', async () => {
  const { app, database, restore } = setupTest();
  try {
    const shot: ShotRecord = {
      id: database.nextShotId++,
      bot_slug: 'bot-alpha',
      title: 'Plans',
      copy: 'Check this offer',
      media_url: 'https://example.com/photo.jpg',
      media_type: 'photo',
      target: 'all_started',
      scheduled_at: null,
      created_at: new Date(),
    };
    database.shots.push(shot);
    database.shotPlans.push({
      id: database.nextPlanId++,
      shot_id: shot.id,
      name: 'Gold',
      price_cents: 9900,
      description: 'Best option',
      sort_order: 0,
    });

    const response = await supertest(app)
      .post(`/api/shots/${shot.id}/preview`)
      .set(AUTH_HEADER)
      .send({
        media_type: 'photo',
        media_url: 'https://example.com/photo.jpg',
        copy: 'Short caption',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.preview.media.type, 'photo');
    assert.equal(response.body.preview.media.caption, 'Short caption');
    assert.ok(Array.isArray(response.body.preview.keyboard));
    assert.ok(response.body.preview.textParts.length >= 1);
  } finally {
    restore();
  }
});

test('validation errors and not found cases', async () => {
  const { app, database, restore } = setupTest();
  try {
    const shot: ShotRecord = {
      id: database.nextShotId++,
      bot_slug: 'bot-alpha',
      title: null,
      copy: 'Copy',
      media_url: null,
      media_type: 'none',
      target: 'all_started',
      scheduled_at: null,
      created_at: new Date(),
    };
    database.shots.push(shot);

    const invalidShot = await supertest(app)
      .post('/api/shots')
      .set(AUTH_HEADER)
      .send({ bot_slug: 'missing', copy: 'Test', media_type: 'photo' });
    assert.equal(invalidShot.status, 400);

    const missingBot = await supertest(app)
      .get('/api/shots')
      .set(AUTH_HEADER);
    assert.equal(missingBot.status, 400);

    const badPlan = await supertest(app)
      .post(`/api/shots/${shot.id}/plans`)
      .set(AUTH_HEADER)
      .send({ name: 'Invalid', price_cents: -10 });
    assert.equal(badPlan.status, 400);

    const reorderInvalid = await supertest(app)
      .post(`/api/shots/${shot.id}/plans/reorder`)
      .set(AUTH_HEADER)
      .send({ order: [999] });
    assert.equal(reorderInvalid.status, 400);

    const notFound = await supertest(app).get('/api/shots/999').set(AUTH_HEADER);
    assert.equal(notFound.status, 404);

    const planNotFound = await supertest(app)
      .put(`/api/shots/${shot.id}/plans/999`)
      .set(AUTH_HEADER)
      .send({ price_cents: 1000 });
    assert.equal(planNotFound.status, 404);

    const triggerMissingDate = await supertest(app)
      .post(`/api/shots/${shot.id}/trigger`)
      .set(AUTH_HEADER)
      .send({ mode: 'schedule' });
    assert.equal(triggerMissingDate.status, 400);
  } finally {
    restore();
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';

function ensureEnv(): void {
  process.env.PORT ??= '8080';
  process.env.APP_BASE_URL ??= 'https://example.com';
  process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
  process.env.ENCRYPTION_KEY ??= '1234567890123456';
  process.env.ADMIN_API_TOKEN ??= 'admintoken123';
  process.env.NODE_ENV ??= 'development';
}

let ShotsMessageBuilder: typeof import('../../src/services/shots/ShotsMessageBuilder.js')['ShotsMessageBuilder'];
test.before(async () => {
  ensureEnv();
  ({ ShotsMessageBuilder } = await import('../../src/services/shots/ShotsMessageBuilder.js'));
});

test.afterEach(() => {
  mock.restoreAll();
});

test('sends photo with caption when copy fits and renders plans keyboard', async () => {
  const chatActions: string[] = [];
  const photoCalls: any[] = [];
  const messageCalls: any[] = [];

  const bot = {
    sendChatAction: mock.fn(async (_chatId: number, action: string) => {
      chatActions.push(action);
      return true;
    }),
    sendPhoto: mock.fn(async (_chatId: number, media: string, options?: any) => {
      photoCalls.push({ media, options });
      return { message_id: 101, media, options };
    }),
    sendVideo: mock.fn(async () => ({ message_id: 0 })),
    sendAudio: mock.fn(async () => ({ message_id: 0 })),
    sendDocument: mock.fn(async () => ({ message_id: 0 })),
    sendMessage: mock.fn(async (_chatId: number, text: string, options: any) => {
      messageCalls.push({ text, options });
      return { message_id: 200 + messageCalls.length, text, options };
    }),
  };

  const introResult = await ShotsMessageBuilder.sendShotIntro(bot, 123, {
    id: 55,
    bot_slug: 'builder-bot',
    title: 'Oferta Especial',
    copy: 'Veja nossa oferta <b>exclusiva</b>!',
    media_url: 'https://example.com/photo.jpg',
    media_type: 'photo',
    target: 'all_started',
    scheduled_at: null,
    created_at: new Date('2025-01-01T00:00:00Z'),
  });

  assert.equal(introResult.mediaMessageId, 101);
  assert.deepEqual(introResult.textMessageIds, []);
  assert.deepEqual(chatActions, ['upload_photo']);
  assert.equal(photoCalls.length, 1);
  assert.equal(photoCalls[0].media, 'https://example.com/photo.jpg');
  assert.equal(photoCalls[0].options.caption, 'Veja nossa oferta <b>exclusiva</b>!');
  assert.equal(photoCalls[0].options.parse_mode, 'HTML');

  const planResult = await ShotsMessageBuilder.sendShotPlans(
    bot,
    123,
    {
      id: 55,
      bot_slug: 'builder-bot',
      title: 'Oferta Especial',
      copy: 'Veja nossa oferta <b>exclusiva</b>!',
      media_url: 'https://example.com/photo.jpg',
      media_type: 'photo',
      target: 'all_started',
      scheduled_at: null,
      created_at: new Date('2025-01-01T00:00:00Z'),
    },
    [
      {
        id: 1,
        shot_id: 55,
        name: 'Plano Ouro',
        price_cents: 15990,
        description: 'Acesso completo <script>alert(1)</script>',
        sort_order: 1,
      },
      {
        id: 2,
        shot_id: 55,
        name: 'Plano Prata',
        price_cents: 9900,
        description: 'Conteúdo essencial',
        sort_order: 2,
      },
    ]
  );

  assert.equal(planResult.planMessageId, 201);
  assert.equal(messageCalls.length, 1);
  assert.match(messageCalls[0].text, /<b>Oferta Especial<\/b>/);
  assert.match(messageCalls[0].text, /<b>Plano Ouro<\/b> — R\$[\s\u00A0]159,90/);
  assert.match(messageCalls[0].text, /<b>Plano Prata<\/b> — R\$[\s\u00A0]99,00/);
  assert.match(messageCalls[0].text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(messageCalls[0].options.parse_mode, 'HTML');
  assert.equal(messageCalls[0].options.disable_web_page_preview, true);
  const keyboard = messageCalls[0].options.reply_markup?.inline_keyboard;
  assert.ok(Array.isArray(keyboard));
  assert.equal(keyboard.length, 2);
  const flattened = keyboard.flat();
  assert.deepEqual(
    flattened.map((btn) => btn.callback_data),
    ['downsell:55:p0', 'downsell:55:p1']
  );
  assert.ok(flattened[0]?.text?.includes('Plano Ouro'));
  assert.ok(flattened[1]?.text?.includes('Plano Prata'));
});

test('splits long copy into chunks when sending video and no plans available', async () => {
  const videoCalls: any[] = [];
  const messageCalls: any[] = [];

  const bot = {
    sendChatAction: mock.fn(async () => true),
    sendPhoto: mock.fn(async () => ({ message_id: 0 })),
    sendVideo: mock.fn(async (_chatId: number, media: string, options?: any) => {
      videoCalls.push({ media, options });
      return { message_id: 301, media, options };
    }),
    sendAudio: mock.fn(async () => ({ message_id: 0 })),
    sendDocument: mock.fn(async () => ({ message_id: 0 })),
    sendMessage: mock.fn(async (_chatId: number, text: string, options: any) => {
      messageCalls.push({ text, options });
      return { message_id: 400 + messageCalls.length, text, options };
    }),
  };

  const longCopy = 'A'.repeat(4200) + '\n' + 'B'.repeat(1500);

  const introResult = await ShotsMessageBuilder.sendShotIntro(bot, 456, {
    id: 88,
    bot_slug: 'video-bot',
    title: 'Video longo',
    copy: longCopy,
    media_url: 'https://example.com/video.mp4',
    media_type: 'video',
    target: 'all_started',
    scheduled_at: null,
    created_at: new Date('2025-01-02T00:00:00Z'),
  });

  assert.equal(videoCalls.length, 1);
  assert.equal(videoCalls[0].options, undefined);
  assert.ok(messageCalls.length >= 2);
  assert.ok(messageCalls.every((call) => call.text.length <= 4096));
  assert.equal(introResult.textMessageIds.length, messageCalls.length);

  const planResult = await ShotsMessageBuilder.sendShotPlans(bot, 456, {
    id: 88,
    bot_slug: 'video-bot',
    title: 'Video longo',
    copy: longCopy,
    media_url: 'https://example.com/video.mp4',
    media_type: 'video',
    target: 'all_started',
    scheduled_at: null,
    created_at: new Date('2025-01-02T00:00:00Z'),
  }, []);

  assert.deepEqual(planResult, {});
  assert.equal(messageCalls.length, introResult.textMessageIds.length);
});

test('sends audio without caption and generates keyboard for three plans', async () => {
  const audioCalls: any[] = [];
  const messageCalls: any[] = [];

  const bot = {
    sendChatAction: mock.fn(async () => true),
    sendPhoto: mock.fn(async () => ({ message_id: 0 })),
    sendVideo: mock.fn(async () => ({ message_id: 0 })),
    sendAudio: mock.fn(async (_chatId: number, media: string, options?: any) => {
      audioCalls.push({ media, options });
      return { message_id: 501, media, options };
    }),
    sendDocument: mock.fn(async () => ({ message_id: 0 })),
    sendMessage: mock.fn(async (_chatId: number, text: string, options: any) => {
      messageCalls.push({ text, options });
      return { message_id: 600 + messageCalls.length, text, options };
    }),
  };

  const copy = 'C'.repeat(1500);

  const introResult = await ShotsMessageBuilder.sendShotIntro(bot, 789, {
    id: 42,
    bot_slug: 'audio-bot',
    title: 'Áudio especial',
    copy,
    media_url: 'https://example.com/audio.mp3',
    media_type: 'audio',
    target: 'all_started',
    scheduled_at: null,
    created_at: new Date('2025-01-03T00:00:00Z'),
  });

  assert.equal(audioCalls.length, 1);
  assert.equal(audioCalls[0].options, undefined);
  assert.equal(introResult.textMessageIds.length, 1);

  const planResult = await ShotsMessageBuilder.sendShotPlans(bot, 789, {
    id: 42,
    bot_slug: 'audio-bot',
    title: 'Áudio especial',
    copy,
    media_url: 'https://example.com/audio.mp3',
    media_type: 'audio',
    target: 'all_started',
    scheduled_at: null,
    created_at: new Date('2025-01-03T00:00:00Z'),
  }, [
    { id: 10, shot_id: 42, name: 'Plano 1', price_cents: 2990, description: 'Primeiro', sort_order: 1 },
    { id: 11, shot_id: 42, name: 'Plano 2', price_cents: 3990, description: 'Segundo', sort_order: 2 },
    { id: 12, shot_id: 42, name: 'Plano 3', price_cents: 4990, description: 'Terceiro', sort_order: 3 },
  ]);

  assert.ok(planResult.planMessageId);
  const planCall = messageCalls.at(-1);
  assert.ok(planCall?.options.reply_markup);
  assert.equal(planCall?.options.reply_markup.inline_keyboard.length, 3);
});

test('falls back to document when photo send fails with bad request', async () => {
  const sendDocumentCalls: any[] = [];

  const bot = {
    sendChatAction: mock.fn(async () => true),
    sendPhoto: mock.fn(async () => {
      const error: any = new Error('bad request');
      error.statusCode = 400;
      throw error;
    }),
    sendVideo: mock.fn(async () => ({ message_id: 0 })),
    sendAudio: mock.fn(async () => ({ message_id: 0 })),
    sendDocument: mock.fn(async (_chatId: number, media: string, options?: any) => {
      sendDocumentCalls.push({ media, options });
      return { message_id: 701, media, options };
    }),
    sendMessage: mock.fn(async () => ({ message_id: 800 })),
  };

  const introResult = await ShotsMessageBuilder.sendShotIntro(bot, 999, {
    id: 77,
    bot_slug: 'fallback-bot',
    title: null,
    copy: 'Legenda curta',
    media_url: 'https://example.com/photo.png',
    media_type: 'photo',
    target: 'all_started',
    scheduled_at: null,
    created_at: new Date('2025-01-04T00:00:00Z'),
  });

  assert.equal(introResult.mediaMessageId, 701);
  assert.equal(sendDocumentCalls.length, 1);
  assert.equal(sendDocumentCalls[0].options.caption, 'Legenda curta');
});

test('does not import legacy plans service', async () => {
  const filePath = path.resolve('src/services/shots/ShotsMessageBuilder.ts');
  const content = await fs.readFile(filePath, 'utf8');
  assert.ok(!content.includes('services/bot/plans.ts'));
});

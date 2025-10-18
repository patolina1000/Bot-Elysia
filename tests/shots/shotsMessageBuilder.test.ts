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

let ShotsMessageBuilder: typeof import('../../src/services/shots/ShotsMessageBuilder.ts')['ShotsMessageBuilder'];
let splitShotCopy: typeof import('../../src/services/shots/ShotsMessageBuilder.ts')['splitShotCopy'];

test.before(async () => {
  ensureEnv();
  ({ ShotsMessageBuilder, splitShotCopy } = await import('../../src/services/shots/ShotsMessageBuilder.ts'));
});

test.afterEach(() => {
  mock.restoreAll();
});

test('splitShotCopy splits respecting newline boundaries', () => {
  const text = 'linha1\nlinha2 que é bem longa\nlinha3';
  const parts = splitShotCopy(text, 10);

  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'linha1\n');
  assert.equal(parts[1], 'linha2 que');
  assert.equal(parts[2], ' é bem lon');
  assert.equal(parts[3], 'ga\nlinha3');
});

test('sendShotIntro sends chat action, media and text parts', async () => {
  const chatActions: string[] = [];
  const photoCalls: any[] = [];
  const messageCalls: any[] = [];

  const api = {
    sendChatAction: mock.fn(async (_chatId: number, action: string) => {
      chatActions.push(action);
      return true;
    }),
    sendPhoto: mock.fn(async (_chatId: number, url: string, options?: any) => {
      photoCalls.push({ url, options });
      return { message_id: 10, url, options };
    }),
    sendMessage: mock.fn(async (_chatId: number, text: string, options: any) => {
      messageCalls.push({ text, options });
      return { message_id: 20 + messageCalls.length, text, options };
    }),
  };

  const result = await ShotsMessageBuilder.sendShotIntro(
    { api },
    123456,
    {
      bot_slug: 'builder-bot',
      copy: 'Olá mundo',
      media_type: 'photo',
      media_url: 'https://example.com/img.jpg',
    }
  );

  assert.deepEqual(chatActions, ['upload_photo']);
  assert.equal(photoCalls.length, 1);
  assert.equal(photoCalls[0].url, 'https://example.com/img.jpg');
  assert.equal(photoCalls[0].options.caption, 'Olá mundo');
  assert.equal(photoCalls[0].options.parse_mode, 'HTML');

  assert.equal(messageCalls.length, 1);
  assert.equal(messageCalls[0].text, 'Olá mundo');
  assert.equal(messageCalls[0].options.parse_mode, 'HTML');
  assert.equal(messageCalls[0].options.disable_web_page_preview, true);

  assert.equal(result.completed, true);
  assert.equal(result.textMessages.length, 1);
});

test('sendShotIntro avoids caption when copy is long and splits text into chunks', async () => {
  const videoCalls: any[] = [];
  const messageCalls: any[] = [];

  const longText = 'A'.repeat(3000) + '\n' + 'B'.repeat(2500);

  const api = {
    sendChatAction: mock.fn(async () => true),
    sendVideo: mock.fn(async (_chatId: number, url: string, options?: any) => {
      videoCalls.push({ url, options });
      return { message_id: 99, url, options };
    }),
    sendMessage: mock.fn(async (_chatId: number, text: string) => {
      messageCalls.push(text);
      return { message_id: 200 + messageCalls.length, text };
    }),
  };

  const result = await ShotsMessageBuilder.sendShotIntro(
    { api },
    777,
    {
      bot_slug: 'builder-bot',
      copy: longText,
      media_type: 'video',
      media_url: 'https://example.com/video.mp4',
    }
  );

  assert.equal(videoCalls.length, 1);
  assert.equal(videoCalls[0].options, undefined);
  assert.equal(messageCalls.length, 2);
  assert.ok(messageCalls[0].length <= 4096);
  assert.ok(messageCalls[1].length <= 4096);
  assert.equal(messageCalls[0] + messageCalls[1], longText);
  assert.equal(result.completed, true);
  assert.equal(result.textMessages.length, 2);
});

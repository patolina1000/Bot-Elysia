import assert from 'node:assert/strict';
import test from 'node:test';

function ensureEnv(): void {
  process.env.APP_BASE_URL ??= 'https://example.com';
  process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
  process.env.ENCRYPTION_KEY ??= '1234567890123456';
  process.env.ADMIN_API_TOKEN ??= 'admintoken123';
  process.env.NODE_ENV ??= 'development';
}

let sanitizeHtmlFn: typeof import('../../src/services/shots/ShotsMessageBuilder.js')['sanitizeHtml'];

async function getSanitizeHtml(): Promise<
  typeof import('../../src/services/shots/ShotsMessageBuilder.js')['sanitizeHtml']
> {
  if (!sanitizeHtmlFn) {
    ensureEnv();
    ({ sanitizeHtml: sanitizeHtmlFn } = await import('../../src/services/shots/ShotsMessageBuilder.js'));
  }

  return sanitizeHtmlFn;
}

test('sanitizeHtml preserves safe anchor links', async () => {
  const sanitizeHtml = await getSanitizeHtml();
  const input = 'Clique <a href="https://example.com/path?x=1&y=2">aqui</a>!';
  const result = sanitizeHtml(input);

  assert.equal(result, 'Clique <a href="https://example.com/path?x=1&y=2">aqui</a>!');
});

test('sanitizeHtml escapes javascript URLs', async () => {
  const sanitizeHtml = await getSanitizeHtml();
  const input = 'Veja <a href="javascript:alert(1)">isso</a> agora';
  const result = sanitizeHtml(input);

  assert.equal(
    result,
    'Veja &lt;a href=&quot;javascript:alert(1)&quot;&gt;isso&lt;/a&gt; agora'
  );
});

test('sanitizeHtml escapes anchors with disallowed attributes', async () => {
  const sanitizeHtml = await getSanitizeHtml();
  const input = 'Clique <a href="https://safe.com" onclick="evil()">aqui</a> hoje';
  const result = sanitizeHtml(input);

  assert.equal(
    result,
    'Clique &lt;a href=&quot;https://safe.com&quot; onclick=&quot;evil()&quot;&gt;aqui&lt;/a&gt; hoje'
  );
});

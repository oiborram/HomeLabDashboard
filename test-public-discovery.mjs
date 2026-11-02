import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

process.env.AUTH_ENABLED = 'true';
process.env.AUTH_CODE_SECRET = 'test-code-secret-abcdefghijklmnopqrstuvwxyz-123456';
process.env.AUTH_SESSION_SECRET = 'test-session-secret-abcdefghijklmnopqrstuvwxyz-123456';
process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
process.env.TELEGRAM_CHAT_ID = '-1001234567890';
const { app } = await import('./server.js');
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(resolve => server.close(resolve)));

test('anonymous GET/HEAD keeps the homelab private and retires the former portfolio sitemap', async () => {
  for (const [path, type, status] of [['/robots.txt', 'text/plain', 200], ['/sitemap.xml', 'text/plain', 410]]) {
    const get = await fetch(origin + path, { headers: { Host: 'untrusted.example', 'X-Forwarded-Host': 'untrusted.example' } });
    const body = await get.text();
    const head = await fetch(origin + path, { method: 'HEAD' });
    assert.equal(get.status, status);
    assert.equal(head.status, status);
    assert.ok(get.headers.get('content-type').startsWith(type));
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
    assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
    assert.equal(await head.text(), '');
    assert.equal(get.headers.get('set-cookie'), null);
    assert.doesNotMatch(body, /untrusted|_dashboard|windrose|daria|_auth/i);
    if (path === '/robots.txt') {
      assert.equal(body, 'User-agent: *\nDisallow: /\n');
    } else {
      assert.match(body, /sitemap has been retired/);
      assert.doesNotMatch(body, /https?:|<loc>|portfolio/i);
    }
  }
});

test('private APIs and near-match discovery paths still require authentication', async () => {
  for (const path of ['/_dashboard/api', '/_dashboard/lisa', '/_auth/check', '/robots.txt/extra', '/sitemap.xml/extra']) {
    const response = await fetch(origin + path, { headers: { Accept: 'application/json' }, redirect: 'manual' });
    assert.equal(response.status, 401, path);
  }
  const page = await fetch(origin + '/', { headers: { Accept: 'text/html' }, redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  for (const path of ['/robots.txt', '/sitemap.xml']) {
    const response = await fetch(origin + path, { method: 'POST', headers: { Accept: 'application/json' } });
    assert.equal(response.status, 401);
  }
});

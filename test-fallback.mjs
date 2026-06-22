import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { app } from './server.js';

async function request(path, headers = {}) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body: await response.text()
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('unknown browser routes render the dashboard', async () => {
  const response = await request('/unknown-route', { Accept: 'text/html' });

  assert.equal(response.status, 200);
  assert.match(response.contentType, /text\/html/);
  assert.match(response.body, /<title>HomeLab Dashboard<\/title>/);
});

test('unknown non-html routes remain 404', async () => {
  const response = await request('/unknown-route.json', { Accept: 'application/json' });

  assert.equal(response.status, 404);
});

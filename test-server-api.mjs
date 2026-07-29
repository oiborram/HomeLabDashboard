import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const controlPath = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-server-api-'));
process.env.AUTH_ENABLED = 'false';
process.env.SERVER_CONTROL_PATH = controlPath;
const { app } = await import('./server.js');

test.after(() => fs.rm(controlPath, { recursive: true, force: true }));

async function request(pathname, options = {}) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    return await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('server control API requires its same-origin action header', async () => {
  const response = await request('/_dashboard/servers/windrose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await fs.readdir(controlPath), []);
});

test('server control API accepts an allowlisted Windrose command', async () => {
  const response = await request('/_dashboard/servers/windrose', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dashboard-Action': 'server-toggle'
    },
    body: JSON.stringify({ enabled: true })
  });
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.serverId, 'windrose');
  assert.equal(body.enabled, true);
  assert.equal((await fs.readdir(path.join(controlPath, 'commands'))).length, 1);
});

test('server control API rejects unknown servers and non-boolean states', async () => {
  const unknown = await request('/_dashboard/servers/not-allowed', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dashboard-Action': 'server-toggle'
    },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(unknown.status, 404);

  const invalid = await request('/_dashboard/servers/windrose', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dashboard-Action': 'server-toggle'
    },
    body: JSON.stringify({ enabled: 'yes' })
  });
  assert.equal(invalid.status, 400);
});

test('Lisa has a lightweight status endpoint separate from the full dashboard', async () => {
  const response = await request('/_dashboard/lisa');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(typeof body.generatedAt, 'string');
  assert.equal(typeof body.lisa, 'object');
  assert.equal('servers' in body, false);
  assert.equal('services' in body, false);
});

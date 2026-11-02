import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queueServerCommand, readManagedServers } from './server-control.js';

async function temporaryControlPath(t) {
  const controlPath = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-server-control-'));
  t.after(() => fs.rm(controlPath, { recursive: true, force: true }));
  return controlPath;
}

test('controller state exposes Windrose when its status is fresh', async t => {
  const controlPath = await temporaryControlPath(t);
  const now = new Date('2026-07-29T17:00:00.000Z');
  await fs.writeFile(path.join(controlPath, 'status.json'), JSON.stringify({
    updatedAt: now.toISOString(),
    servers: [{ id: 'windrose', status: 'running' }]
  }));

  const [windrose] = await readManagedServers({ controlPath, now: now.getTime() });

  assert.equal(windrose.name, 'Windrose');
  assert.equal(windrose.running, true);
  assert.equal(windrose.available, true);
  assert.equal(windrose.logo, '/assets/servers/windrose.jpg');
});

test('controller state exposes Enshrouded independently from Windrose', async t => {
  const controlPath = await temporaryControlPath(t);
  const now = new Date('2026-09-14T17:00:00.000Z');
  await fs.writeFile(path.join(controlPath, 'status.json'), JSON.stringify({
    updatedAt: now.toISOString(),
    servers: [
      { id: 'windrose', status: 'stopped' },
      { id: 'enshrouded', status: 'running' }
    ]
  }));

  const servers = await readManagedServers({ controlPath, now: now.getTime() });
  const enshrouded = servers.find(server => server.id === 'enshrouded');

  assert.equal(enshrouded.name, 'Enshrouded');
  assert.equal(enshrouded.running, true);
  assert.equal(enshrouded.available, true);
  assert.equal(enshrouded.logo, '/assets/servers/enshrouded.jpg');
});

test('controller state exposes Enshrouded while SteamCMD is updating it', async t => {
  const controlPath = await temporaryControlPath(t);
  const now = new Date('2026-09-14T18:00:00.000Z');
  await fs.writeFile(path.join(controlPath, 'status.json'), JSON.stringify({
    updatedAt: now.toISOString(),
    servers: [{ id: 'enshrouded', status: 'updating', message: 'Actualizando servidor con SteamCMD' }]
  }));

  const servers = await readManagedServers({ controlPath, now: now.getTime() });
  const enshrouded = servers.find(server => server.id === 'enshrouded');

  assert.equal(enshrouded.status, 'updating');
  assert.equal(enshrouded.running, false);
  assert.equal(enshrouded.available, true);
  assert.equal(enshrouded.message, 'Actualizando servidor con SteamCMD');
});

test('stale or absent controller state disables server controls', async t => {
  const controlPath = await temporaryControlPath(t);
  const [missing] = await readManagedServers({ controlPath });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.available, false);

  await fs.writeFile(path.join(controlPath, 'status.json'), JSON.stringify({
    updatedAt: '2026-07-29T16:00:00.000Z',
    servers: [{ id: 'windrose', status: 'running' }]
  }));
  const [stale] = await readManagedServers({
    controlPath,
    now: Date.parse('2026-07-29T17:00:00.000Z')
  });
  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.running, false);
});

test('commands are atomically queued only for configured servers', async t => {
  const controlPath = await temporaryControlPath(t);
  const command = await queueServerCommand('windrose', true, {
    controlPath,
    now: new Date('2026-07-29T17:00:00.000Z')
  });
  const queuedPath = path.join(controlPath, 'commands', `${command.commandId}.json`);
  const queued = JSON.parse(await fs.readFile(queuedPath, 'utf8'));

  assert.equal(queued.serverId, 'windrose');
  assert.equal(queued.enabled, true);
  assert.equal(queued.requestedAt, '2026-07-29T17:00:00.000Z');
  assert.deepEqual(
    (await fs.readdir(path.join(controlPath, 'commands'))).filter(file => file.endsWith('.tmp')),
    []
  );

  await assert.rejects(
    queueServerCommand('not-allowed', true, { controlPath }),
    error => error.code === 'UNKNOWN_SERVER'
  );

  const enshroudedCommand = await queueServerCommand('enshrouded', false, { controlPath });
  assert.equal(enshroudedCommand.serverId, 'enshrouded');
  assert.equal(enshroudedCommand.enabled, false);
  await assert.rejects(
    queueServerCommand('windrose', 'yes', { controlPath }),
    error => error.code === 'INVALID_STATE'
  );
});

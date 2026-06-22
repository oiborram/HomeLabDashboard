import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readLisaStatus } from './server.js';

test('readLisaStatus reports offline when Lisa state is not mounted', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-lisa-offline-'));
  const status = await readLisaStatus({
    stateFilePath: path.join(directory, 'state.json'),
    activeDeploymentPath: path.join(directory, 'deploying.txt')
  });

  assert.equal(status.status, 'offline');
  assert.equal(status.available, false);
  assert.equal(status.deploying, false);
  assert.equal(status.reason, 'missing_state');
  assert.deepEqual(status.history, []);
});

test('readLisaStatus builds recent deployments from Lisa state.json', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-lisa-state-'));
  const stateFilePath = path.join(directory, 'state.json');
  await fs.writeFile(stateFilePath, `\uFEFF${JSON.stringify({
    Repositories: {
      'oiborram/daria': {
        RepositoryId: 1,
        FullName: 'oiborram/daria',
        Branch: 'deploy',
        CommitSha: '1234567890abcdef',
        LocalPath: 'data/repositories/daria',
        LastFetchedAtUtc: '2026-06-20T10:30:00Z'
      },
      'oiborram/lisa': {
        RepositoryId: 2,
        FullName: 'oiborram/lisa',
        Branch: 'deploy',
        CommitSha: 'abcdef1234567890',
        LocalPath: 'data/repositories/lisa',
        LastFetchedAtUtc: '2026-06-21T08:15:00Z'
      }
    }
  })}`, 'utf8');

  const status = await readLisaStatus({
    stateFilePath,
    activeDeploymentPath: path.join(directory, 'deploying.txt')
  });

  assert.equal(status.status, 'idle');
  assert.equal(status.available, true);
  assert.equal(status.deploying, false);
  assert.equal(status.repositories.length, 2);
  assert.equal(status.history.length, 2);
  assert.equal(status.history[0].repository, 'oiborram/lisa');
  assert.equal(status.history[0].message, 'Desplegado oiborram/lisa @ abcdef1');
  assert.equal(status.history[1].repository, 'oiborram/daria');
});

test('readLisaStatus marks Lisa as working when active deployment marker exists', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-lisa-working-'));
  const stateFilePath = path.join(directory, 'state.json');
  const activeDeploymentPath = path.join(directory, 'deploying.txt');
  await fs.writeFile(stateFilePath, JSON.stringify({ Repositories: {} }), 'utf8');
  await fs.writeFile(activeDeploymentPath, 'daria', 'utf8');

  const status = await readLisaStatus({
    stateFilePath,
    activeDeploymentPath
  });

  assert.equal(status.status, 'working');
  assert.equal(status.available, true);
  assert.equal(status.deploying, true);
  assert.equal(status.application, 'daria');
  assert.deepEqual(status.deploymentPhases, []);
});

test('readLisaStatus exposes active deployment phases from JSON marker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-lisa-phases-'));
  const stateFilePath = path.join(directory, 'state.json');
  const activeDeploymentPath = path.join(directory, 'deploying.txt');
  await fs.writeFile(stateFilePath, JSON.stringify({ Repositories: {} }), 'utf8');
  await fs.writeFile(activeDeploymentPath, JSON.stringify({
    Application: 'daria',
    Phases: [
      { Name: 'Preparando', Status: 'done', Detail: 'Backup de configuración' },
      { Name: 'Inspección', Status: 'running', Detail: 'Compatibilidad de datos' },
      { Name: 'Reconstrucción', Status: 'pending' }
    ]
  }), 'utf8');

  const status = await readLisaStatus({
    stateFilePath,
    activeDeploymentPath
  });

  assert.equal(status.status, 'working');
  assert.equal(status.application, 'daria');
  assert.equal(status.currentDeployment.application, 'daria');
  assert.deepEqual(status.deploymentPhases, [
    { name: 'Preparando', status: 'done', detail: 'Backup de configuración' },
    { name: 'Inspección', status: 'current', detail: 'Compatibilidad de datos' },
    { name: 'Reconstrucción', status: 'pending', detail: '' }
  ]);
});

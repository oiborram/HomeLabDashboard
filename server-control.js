import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const managedServerDefinitions = Object.freeze([
  Object.freeze({
    id: 'windrose',
    name: 'Windrose',
    logo: '/assets/servers/windrose.jpg'
  })
]);

const definitionById = new Map(managedServerDefinitions.map(server => [server.id, server]));

export async function readManagedServers({
  controlPath = process.env.SERVER_CONTROL_PATH ?? '/app/server-control',
  now = Date.now(),
  staleAfterMs = 75_000
} = {}) {
  let controllerState = null;

  try {
    const content = await fs.readFile(path.join(controlPath, 'status.json'), 'utf8');
    controllerState = JSON.parse(content.replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw error;
    }
  }

  const updatedAt = controllerState?.updatedAt ?? null;
  const updatedTime = Date.parse(updatedAt);
  const controllerAvailable =
    Number.isFinite(updatedTime) &&
    now - updatedTime >= 0 &&
    now - updatedTime <= staleAfterMs;
  const stateById = new Map(
    Array.isArray(controllerState?.servers)
      ? controllerState.servers.map(server => [server.id, server])
      : []
  );

  return managedServerDefinitions.map(definition => {
    const state = stateById.get(definition.id);
    const status = controllerAvailable && state ? normalizeStatus(state.status) : 'unavailable';

    return {
      ...definition,
      status,
      running: status === 'running',
      available: controllerAvailable,
      updatedAt,
      message: controllerAvailable
        ? normalizeMessage(state?.message)
        : 'Controlador de Windows no disponible'
    };
  });
}

export async function queueServerCommand(serverId, enabled, {
  controlPath = process.env.SERVER_CONTROL_PATH ?? '/app/server-control',
  now = new Date()
} = {}) {
  if (!definitionById.has(serverId)) {
    const error = new Error('Servidor no configurado');
    error.code = 'UNKNOWN_SERVER';
    throw error;
  }

  if (typeof enabled !== 'boolean') {
    const error = new TypeError('El estado solicitado debe ser booleano');
    error.code = 'INVALID_STATE';
    throw error;
  }

  const commandsPath = path.join(controlPath, 'commands');
  await fs.mkdir(commandsPath, { recursive: true });

  const commandId = crypto.randomUUID();
  const command = {
    version: 1,
    commandId,
    serverId,
    enabled,
    requestedAt: now.toISOString()
  };
  const finalPath = path.join(commandsPath, `${commandId}.json`);
  const temporaryPath = `${finalPath}.tmp`;

  await fs.writeFile(temporaryPath, `${JSON.stringify(command)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  });
  await fs.rename(temporaryPath, finalPath);

  return command;
}

function normalizeStatus(status) {
  return ['running', 'stopped', 'starting', 'stopping', 'error'].includes(status)
    ? status
    : 'error';
}

function normalizeMessage(message) {
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 240) : null;
}

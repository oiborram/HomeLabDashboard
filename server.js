import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
export { app };
const port = Number(process.env.PORT ?? 3000);
const nginxConfigPath = process.env.NGINX_CONFIG_PATH ?? '/app/config/default.conf';
const npmProxyHostDir = process.env.NPM_PROXY_HOST_DIR ?? '/app/npm-proxy-hosts';
const lisaStateFilePath =
  process.env.LISA_STATE_FILE_PATH ??
  process.env.Lisa__StateFilePath ??
  '/app/lisa-data/state.json';
const lisaActiveDeploymentPath =
  process.env.LISA_ACTIVE_DEPLOYMENT_PATH ??
  process.env.LISA_DEPLOYING_PATH ??
  '/app/lisa-data/deploying.txt';
const lisaDeploymentStatusPath =
  process.env.LISA_DEPLOYMENT_STATUS_PATH ??
  process.env.Lisa__DeploymentStatusPath ??
  '/app/lisa-data/deployment-status.json';
const legacyAssetOrigin = process.env.LEGACY_ASSET_ORIGIN ?? 'http://dnd-control-panel';

app.get('/assets/*', proxyLegacyAsset);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/_dashboard/api', async (request, response) => {
  const [services, publicHosts, lisa] = await Promise.all([
    readServices(),
    readPublicHosts(),
    readLisaStatus()
  ]);

  response.json({
    generatedAt: new Date().toISOString(),
    publicHosts,
    services: services.map(service => ({
      ...service,
      url: buildServiceUrl(request, service.path, service.kind)
    })),
    lisa
  });
});

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('*', (request, response, next) => {
  if (!request.accepts('html')) {
    next();
    return;
  }

  response.sendFile(path.join(__dirname, 'public', 'index.html'));
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(port, () => {
    console.log(`HomeLabDashboard listening on ${port}`);
  });
}

export async function readServices(configPath = nginxConfigPath) {
  let config = '';
  try {
    config = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  return parseNginxLocations(config)
    .filter(service => service.path !== '/')
    .filter(service => !isStaticAssetPath(service.path))
    .filter(service => !isTechnicalApiDocPath(service.path))
    .filter(service => !service.path.startsWith('/_dashboard'))
    .sort((left, right) => left.path.localeCompare(right.path, 'es'));
}

async function proxyLegacyAsset(request, response, next) {
  try {
    const upstreamUrl = new URL(request.originalUrl, legacyAssetOrigin);
    const upstreamResponse = await fetch(upstreamUrl);

    if (!upstreamResponse.ok || upstreamResponse.body === null) {
      response.sendStatus(upstreamResponse.status);
      return;
    }

    response.status(upstreamResponse.status);
    for (const [header, value] of upstreamResponse.headers) {
      if (!['connection', 'content-encoding', 'transfer-encoding'].includes(header.toLowerCase())) {
        response.setHeader(header, value);
      }
    }

    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    response.send(buffer);
  } catch (error) {
    next(error);
  }
}

export function parseNginxLocations(config) {
  const services = [];
  const locationPattern = /^\s*location\s+(=\s+)?([^\s{]+)\s*\{/gm;
  let match;

  while ((match = locationPattern.exec(config)) !== null) {
    const locationStart = match.index;
    const routePath = normalizeRoutePath(match[2], Boolean(match[1]));
    if (!routePath || routePath === '/favicon.ico') {
      continue;
    }

    const block = readBalancedBlock(config, locationPattern.lastIndex - 1);
    const proxyPass = block.match(/proxy_pass\s+([^;]+);/)?.[1]?.trim() ?? null;
    const redirectTo = block.match(/return\s+30[178]\s+([^;]+);/)?.[1]?.trim() ?? null;

    if (!proxyPass && !redirectTo) {
      continue;
    }

    services.push({
      id: serviceId(routePath),
      name: serviceName(routePath),
      path: routePath,
      kind: inferKind(routePath, proxyPass),
      origin: inferOrigin(config, locationStart),
      upstream: proxyPass,
      redirectTo,
      source: 'nginx'
    });
  }

  return dedupeLocations(services);
}

async function readPublicHosts() {
  try {
    const files = await fs.readdir(npmProxyHostDir);
    const hosts = [];

    for (const file of files.filter(fileName => fileName.endsWith('.conf'))) {
      const config = await fs.readFile(path.join(npmProxyHostDir, file), 'utf8');
      const serverNames = config.match(/server_name\s+([^;]+);/)?.[1]
        ?.split(/\s+/)
        .filter(Boolean) ?? [];

      hosts.push(...serverNames.filter(host => host !== '_'));
    }

    return [...new Set(hosts)].sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export async function readLisaStatus(options = {}) {
  const stateFilePath = options.stateFilePath ?? lisaStateFilePath;
  const activeDeploymentPath = options.activeDeploymentPath ?? lisaActiveDeploymentPath;
  const deploymentStatusPath = options.deploymentStatusPath ?? lisaDeploymentStatusPath;
  const [stateResult, activeDeployment, activeProgress] = await Promise.all([
    readLisaDeploymentState(stateFilePath),
    readActiveLisaDeployment(activeDeploymentPath),
    readLisaDeploymentProgress(deploymentStatusPath)
  ]);
  const watcher = await readLisaWatcherControl(stateFilePath);

  if (!stateResult.available) {
    return {
      status: 'offline',
      available: false,
      deploying: false,
      application: null,
      reason: stateResult.reason,
      stateFilePath,
      deploymentStatusPath,
      watcher,
      repositories: [],
      history: []
    };
  }

  const repositories = normalizeLisaRepositories(stateResult.state);
  const history = buildLisaHistory(repositories);
  const deployment = normalizeActiveDeployment(activeDeployment, activeProgress);
  const deploying = Boolean(deployment);

  return {
    status: deploying ? 'working' : 'idle',
    available: true,
    deploying,
    application: deployment?.application ?? null,
    deployment,
    reason: null,
    stateFilePath,
    deploymentStatusPath,
    watcher,
    repositories: repositories.map(repository => ({
      fullName: repository.fullName,
      branch: repository.branch,
      commitSha: repository.commitSha,
      localPath: repository.localPath,
      lastFetchedAtUtc: repository.lastFetchedAtUtc
    })),
    history
  };
}

async function readLisaDeploymentState(stateFilePath) {
  try {
    const content = (await fs.readFile(stateFilePath, 'utf8')).replace(/^\uFEFF/u, '');
    return {
      available: true,
      state: JSON.parse(content),
      reason: null
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        available: false,
        state: null,
        reason: 'missing_state'
      };
    }

    if (error instanceof SyntaxError) {
      return {
        available: false,
        state: null,
        reason: 'invalid_state'
      };
    }

    return {
      available: false,
      state: null,
      reason: 'unreadable_state'
    };
  }
}

async function readActiveLisaDeployment(activeDeploymentPath) {
  try {
    const application = (await fs.readFile(activeDeploymentPath, 'utf8')).trim();
    return application || 'despliegue activo';
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    return null;
  }
}

async function readLisaDeploymentProgress(deploymentStatusPath) {
  try {
    const content = (await fs.readFile(deploymentStatusPath, 'utf8')).replace(/^\uFEFF/u, '');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }

    return null;
  }
}

function normalizeActiveDeployment(activeDeployment, progress) {
  if (!activeDeployment && !progress) {
    return null;
  }

  const application = getLisaField(progress, 'Application', 'application') ?? activeDeployment ?? 'despliegue activo';
  const phase = getLisaField(progress, 'Phase', 'phase') ?? 'deploying';
  const phaseLabel = getLisaField(progress, 'PhaseLabel', 'phaseLabel') ?? 'Despliegue en curso';

  return {
    application,
    repository: getLisaField(progress, 'Repository', 'repository') ?? null,
    commitSha: getLisaField(progress, 'CommitSha', 'commitSha') ?? null,
    phase,
    phaseLabel,
    startedAtUtc: getLisaField(progress, 'StartedAtUtc', 'startedAtUtc') ?? null,
    updatedAtUtc: getLisaField(progress, 'UpdatedAtUtc', 'updatedAtUtc') ?? null,
    route: getLisaField(progress, 'Route', 'route') ?? null,
    details: getLisaField(progress, 'Details', 'details') ?? null,
    artifacts: getLisaField(progress, 'Artifacts', 'artifacts') ?? null
  };
}

async function readLisaWatcherControl(stateFilePath) {
  const directory = path.dirname(stateFilePath);
  const pidFilePath = path.join(directory, 'lisa-watcher.pid');

  try {
    const pidText = (await fs.readFile(pidFilePath, 'utf8')).trim();
    const pid = Number(pidText);
    const running = Number.isInteger(pid) && pid > 0 && isProcessRunning(pid);

    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      running,
      pidFilePath
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        pid: null,
        running: false,
        pidFilePath
      };
    }

    return {
      pid: null,
      running: false,
      pidFilePath,
      error: 'unreadable_pid'
    };
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function normalizeLisaRepositories(state) {
  const repositories = getLisaField(state, 'Repositories', 'repositories') ?? {};

  return Object.entries(repositories)
    .map(([key, repository]) => {
      const fullName = getLisaField(repository, 'FullName', 'fullName') ?? key;
      const commitSha = getLisaField(repository, 'CommitSha', 'commitSha') ?? '';
      const lastFetchedAtUtc = getLisaField(repository, 'LastFetchedAtUtc', 'lastFetchedAtUtc') ?? null;

      return {
        fullName,
        branch: getLisaField(repository, 'Branch', 'branch') ?? 'deploy',
        commitSha,
        localPath: getLisaField(repository, 'LocalPath', 'localPath') ?? '',
        lastFetchedAtUtc
      };
    })
    .filter(repository => repository.fullName);
}

function buildLisaHistory(repositories, limit = 6) {
  return repositories
    .filter(repository => repository.lastFetchedAtUtc && !Number.isNaN(new Date(repository.lastFetchedAtUtc).getTime()))
    .sort((left, right) => new Date(right.lastFetchedAtUtc).getTime() - new Date(left.lastFetchedAtUtc).getTime())
    .slice(0, limit)
    .map(repository => ({
      timestamp: repository.lastFetchedAtUtc,
      kind: 'success',
      repository: repository.fullName,
      commitSha: repository.commitSha,
      message: `Desplegado ${repository.fullName}${repository.commitSha ? ` @ ${repository.commitSha.slice(0, 7)}` : ''}`
    }));
}

function getLisaField(source, pascalName, camelName) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  return source[pascalName] ?? source[camelName];
}

function readBalancedBlock(content, openingBraceIndex) {
  let depth = 0;

  for (let index = openingBraceIndex; index < content.length; index += 1) {
    const character = content[index];
    if (character === '{') {
      depth += 1;
    }

    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(openingBraceIndex + 1, index);
      }
    }
  }

  return content.slice(openingBraceIndex + 1);
}

function dedupeLocations(services) {
  const byPath = new Map();

  for (const service of services) {
    const canonicalPath = canonicalRoutePath(service.path);
    const existing = byPath.get(canonicalPath);
    if (!existing || (!existing.upstream && service.upstream)) {
      byPath.set(canonicalPath, service);
    }
  }

  return [...byPath.values()];
}

function normalizeRoutePath(routePath, isExact) {
  if (!routePath.startsWith('/')) {
    return null;
  }

  if (isExact && routePath.length > 1 && routePath.endsWith('/')) {
    return routePath.slice(0, -1);
  }

  return routePath;
}

function canonicalRoutePath(routePath) {
  if (routePath.length > 1 && routePath.endsWith('/')) {
    return routePath.slice(0, -1);
  }

  return routePath;
}

function serviceId(routePath) {
  return routePath.replace(/^\/+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
}

function serviceName(routePath) {
  const firstSegment = routePath.split('/').filter(Boolean).join(' ');
  return firstSegment
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function inferKind(routePath, upstream) {
  if (routePath.includes('/api') || routePath === '/api') {
    return 'API';
  }

  if (upstream?.includes('host.docker.internal')) {
    return 'Host';
  }

  return 'Web';
}

function isStaticAssetPath(routePath) {
  return /\.(?:avif|css|gif|ico|jpeg|jpg|js|map|otf|png|svg|ttf|webp|woff|woff2)$/i.test(routePath);
}

function isTechnicalApiDocPath(routePath) {
  return /\/(?:openapi|swagger)\//i.test(routePath);
}

function inferOrigin(config, locationStart) {
  const managedStart = config.lastIndexOf('# <lisa-managed>', locationStart);
  const managedEnd = config.lastIndexOf('# </lisa-managed>', locationStart);
  return managedStart > managedEnd ? 'Ilicilabs' : 'Otros';
}

function buildServiceUrl(_request, routePath, kind) {
  if (kind === 'API') {
    if (routePath === '/api/') {
      return appendPath(routePath, 'swagger/index.html');
    }

    return appendPath(routePath, 'openapi/v1.json');
  }

  return routePath.endsWith('/') ? routePath : `${routePath}/`;
}

function appendPath(routePath, segment) {
  return `${routePath.endsWith('/') ? routePath : `${routePath}/`}${segment}`;
}


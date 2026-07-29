import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthService } from './auth.js';

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
const lisaDeploymentManifestPath = process.env.LISA_DEPLOYMENT_MANIFEST_PATH ?? '/app/lisa-data/deployments.json';
const ilicilabsWorkspacePath = process.env.ILICILABS_WORKSPACE_PATH ?? 'C:\\dev\\Ilicilabs';
const ilicilabsExcludedApps = parseList(
  process.env.ILICILABS_EXCLUDED_APPS ?? 'dnd-frontend,DNDDynamicSheet_Front,oiborram/DNDDynamicSheet_Front');
const legacyAssetOrigin = process.env.LEGACY_ASSET_ORIGIN ?? 'http://dnd-control-panel';
const auth = createAuthService();

app.set('trust proxy', process.env.AUTH_TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '1kb', type: 'application/json' }));

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    authentication: {
      enabled: auth.enabled,
      configured: auth.isConfigured()
    }
  });
});

app.get('/login', sendPublicFile('login.html'));
app.get('/login.css', sendPublicFile('login.css'));
app.get('/login.js', sendPublicFile('login.js'));

app.get('/auth/status', (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json(auth.publicStatus(request));
});

app.post('/auth/login', (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  const result = auth.verifyLoginCode(request.body?.code, request.ip);

  if (!result.ok) {
    if (result.retryAfter) {
      response.setHeader('Retry-After', result.retryAfter);
    }
    response.status(result.status).json(result);
    return;
  }

  auth.issueSession(response);
  response.sendStatus(204);
});

app.post('/auth/logout', (_request, response) => {
  auth.clearSession(response);
  response.sendStatus(204);
});

app.get('/_auth/check', (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (!auth.isConfigured() && auth.enabled) {
    response.sendStatus(503);
    return;
  }

  response.sendStatus(auth.isAuthenticated(request) ? 204 : 401);
});

app.use((request, response, next) => {
  if (!auth.isConfigured() && auth.enabled) {
    if (isPageNavigation(request)) {
      response.redirect(302, '/login');
      return;
    }
    response.status(503).json({ error: 'El acceso todavía no está configurado.' });
    return;
  }

  if (!auth.isAuthenticated(request)) {
    if (isPageNavigation(request)) {
      response.redirect(302, '/login');
      return;
    }
    response.status(401).json({ error: 'La sesión no es válida o ha caducado.' });
    return;
  }

  next();
});

app.get('/assets/*', proxyLegacyAsset);
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '5m'
}));

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
    if (auth.enabled && !auth.isConfigured()) {
      console.error(`Autenticación bloqueada por configuración incompleta: ${auth.configurationIssues.join('; ')}`);
    }
    void auth.startPublisher();
  });
}

function sendPublicFile(fileName) {
  return (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.sendFile(path.join(__dirname, 'public', fileName));
  };
}

function securityHeaders(request, response, next) {
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'"
  ].join('; '));
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

function isPageNavigation(request) {
  return request.method === 'GET'
    && !path.extname(request.path)
    && request.accepts('html');
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

  const deployments = await readLisaDeployments();

  return parseNginxLocations(config, deployments)
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

export function parseNginxLocations(config, deployments = null) {
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
      origin: inferOrigin(config, locationStart, routePath, deployments),
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

async function readLisaDeployments() {
  try {
    const manifest = JSON.parse(await fs.readFile(lisaDeploymentManifestPath, 'utf8'));
    return (manifest.Applications ?? [])
      .filter(application => typeof application.Route === 'string')
      .map(application => ({
        route: application.Route,
        localPath: application.LocalPath,
        origin: isIlicilabsDeployment(application) ? 'Ilicilabs' : 'Otros'
      }));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function isIlicilabsDeployment(application) {
  if (isExcludedIlicilabsApp(application)) {
    return false;
  }

  return isPathWithin(application.LocalPath, ilicilabsWorkspacePath);
}

function isExcludedIlicilabsApp(application) {
  return [
    application.Route,
    application.ServiceName,
    application.RepositoryName,
    application.RepositoryFullName
  ]
    .filter(Boolean)
    .some(value => ilicilabsExcludedApps.includes(value.toLowerCase()));
}

function parseList(value) {
  return value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function isPathWithin(candidatePath, parentPath) {
  if (typeof candidatePath !== 'string' || typeof parentPath !== 'string') {
    return false;
  }

  const candidate = normalizeFilesystemPath(candidatePath);
  const parent = normalizeFilesystemPath(parentPath);
  return candidate === parent || candidate.startsWith(`${parent}\\`);
}

function normalizeFilesystemPath(filesystemPath) {
  return filesystemPath
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .replace(/\\+$/u, '')
    .toLowerCase();
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
    deploymentPhases: deployment?.phases ?? [],
    currentDeployment: deployment,
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
    if (!application) {
      return 'despliegue activo';
    }

    try {
      return JSON.parse(application);
    } catch {
      return application;
    }
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

  const source = progress && typeof progress === 'object'
    ? progress
    : activeDeployment && typeof activeDeployment === 'object'
      ? activeDeployment
      : null;
  const application =
    getLisaField(source, 'Application', 'application') ??
    getLisaField(source, 'App', 'app') ??
    getLisaField(source, 'Name', 'name') ??
    (typeof activeDeployment === 'string' ? activeDeployment : 'despliegue activo');
  const phase = getLisaField(source, 'Phase', 'phase') ?? 'deploying';
  const phaseLabel = getLisaField(source, 'PhaseLabel', 'phaseLabel') ?? 'Despliegue en curso';
  const phases =
    getLisaField(source, 'Phases', 'phases') ??
    getLisaField(source, 'Steps', 'steps') ??
    [];

  return {
    application,
    repository: getLisaField(source, 'Repository', 'repository') ?? null,
    commitSha: getLisaField(source, 'CommitSha', 'commitSha') ?? null,
    phase,
    phaseLabel,
    startedAtUtc: getLisaField(source, 'StartedAtUtc', 'startedAtUtc') ?? null,
    updatedAtUtc: getLisaField(source, 'UpdatedAtUtc', 'updatedAtUtc') ?? null,
    route: getLisaField(source, 'Route', 'route') ?? null,
    details: getLisaField(source, 'Details', 'details') ?? null,
    artifacts: getLisaField(source, 'Artifacts', 'artifacts') ?? null,
    phases: normalizeDeploymentPhases(phases, phase)
  };
}

function normalizeDeploymentPhases(phases, currentPhase) {
  if (!Array.isArray(phases)) {
    return [];
  }

  return phases
    .map((phase, index) => {
      if (typeof phase === 'string') {
        return {
          id: `phase-${index + 1}`,
          label: phase,
          name: phase,
          status: index === 0 ? 'current' : 'pending',
          detail: ''
        };
      }

      if (!phase || typeof phase !== 'object') {
        return {
          id: `phase-${index + 1}`,
          label: `Fase ${index + 1}`,
          name: `Fase ${index + 1}`,
          status: 'pending',
          detail: ''
        };
      }

      const id = getLisaField(phase, 'Id', 'id') ?? `phase-${index + 1}`;
      const label =
        getLisaField(phase, 'Label', 'label') ??
        getLisaField(phase, 'Name', 'name') ??
        getLisaField(phase, 'Title', 'title') ??
        `Fase ${index + 1}`;
      const rawStatus = getLisaField(phase, 'Status', 'status') ?? getLisaField(phase, 'State', 'state');

      return {
        id,
        label,
        name: label,
        status: normalizeDeploymentPhaseStatus(rawStatus, id, currentPhase),
        detail:
          getLisaField(phase, 'Detail', 'detail') ??
          getLisaField(phase, 'Description', 'description') ??
          getLisaField(phase, 'Message', 'message') ??
          ''
      };
    })
    .filter(phase => phase.id && phase.label);
}

function normalizeDeploymentPhaseStatus(status, id, currentPhase) {
  const value = String(status ?? '').toLowerCase();
  if (['done', 'completed', 'complete', 'success', 'hecha'].includes(value)) {
    return 'done';
  }

  if (['current', 'active', 'running', 'in_progress', 'now', 'ahora'].includes(value) || id === currentPhase) {
    return 'current';
  }

  if (['failed', 'error', 'danger'].includes(value)) {
    return 'failed';
  }

  return 'pending';
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

function inferOrigin(config, locationStart, routePath, deployments) {
  const deployment = deployments?.find(application => routeBelongsToDeployment(routePath, application.route));
  if (deployment) {
    return deployment.origin;
  }

  if (deployments) {
    return 'Otros';
  }

  const managedStart = config.lastIndexOf('# <lisa-managed>', locationStart);
  const managedEnd = config.lastIndexOf('# </lisa-managed>', locationStart);
  return managedStart > managedEnd ? 'Ilicilabs' : 'Otros';
}

function routeBelongsToDeployment(routePath, deploymentRoute) {
  const normalizedRoute = deploymentRoute.replace(/^\/+|\/+$/gu, '');
  const canonicalPath = canonicalRoutePath(routePath);

  if (!normalizedRoute) {
    return canonicalPath === '/';
  }

  const routePrefix = `/${normalizedRoute}`;
  return canonicalPath === routePrefix || canonicalPath.startsWith(`${routePrefix}/`);
}

function buildServiceUrl(_request, routePath, kind) {
  if (kind === 'API') {
    return appendPath(routePath, 'swagger/index.html');
  }

  return routePath.endsWith('/') ? routePath : `${routePath}/`;
}

function appendPath(routePath, segment) {
  return `${routePath.endsWith('/') ? routePath : `${routePath}/`}${segment}`;
}

import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = Number(process.env.PORT ?? 3000);
const nginxConfigPath = process.env.NGINX_CONFIG_PATH ?? '/app/config/default.conf';
const npmProxyHostDir = process.env.NPM_PROXY_HOST_DIR ?? '/app/npm-proxy-hosts';
const lisaDeployingPath = process.env.LISA_DEPLOYING_PATH ?? '/app/lisa-data/deploying.txt';
const lisaLogsPath = process.env.LISA_LOGS_PATH ?? '/app/lisa-logs';
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

async function readLisaStatus() {
  const history = await readLisaHistory();

  try {
    const appName = (await fs.readFile(lisaDeployingPath, 'utf8')).trim();
    return {
      deploying: true,
      application: appName || 'desconocida',
      history
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        deploying: false,
        application: null,
        history
      };
    }

    throw error;
  }
}

async function readLisaHistory(limit = 6) {
  try {
    const files = (await fs.readdir(lisaLogsPath))
      .filter(fileName => /^worker-\d{8}\.log$/u.test(fileName))
      .sort()
      .reverse();
    const events = [];

    for (const file of files) {
      const content = await fs.readFile(path.join(lisaLogsPath, file), 'utf8');
      for (const line of content.split(/\r?\n/u).filter(Boolean)) {
        const event = parseLisaLogLine(line);
        if (event) {
          events.push(event);
        }

        if (events.length >= limit) {
          return events;
        }
      }
    }

    return events;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function parseLisaLogLine(line) {
  const match = line.match(/^(\S+)\s+(.+)$/u);
  if (!match) {
    return null;
  }

  const [, timestamp, message] = match;
  const kind = message.startsWith('Deploying ')
    ? 'deploying'
    : message.startsWith('Deployment succeeded ')
      ? 'success'
      : message.startsWith('Rollback completed ')
        ? 'rollback'
        : null;

  if (!kind) {
    return null;
  }

  return {
    timestamp,
    kind,
    message: summarizeLisaEvent(message)
  };
}

function summarizeLisaEvent(message) {
  return message
    .replace(/^Deploying /u, 'Desplegando ')
    .replace(/^Deployment succeeded for /u, 'Desplegado ')
    .replace(/^Rollback completed for /u, 'Rollback ')
    .replace(/\s+commit\s+/u, ' @ ');
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

  return routePath;
}

function appendPath(routePath, segment) {
  return `${routePath.endsWith('/') ? routePath : `${routePath}/`}${segment}`;
}

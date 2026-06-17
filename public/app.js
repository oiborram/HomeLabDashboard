const servicesEl = document.querySelector('#services');
const emptyEl = document.querySelector('#empty');
const searchEl = document.querySelector('#search');
const summaryEl = document.querySelector('#summary');
const lisaStatusEl = document.querySelector('#lisaStatus');
const hostListEl = document.querySelector('#hostList');

let services = [];
let latestLisa = {
  deploying: false,
  application: null,
  history: []
};

async function loadDashboard() {
  const response = await fetch('/_dashboard/api', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Dashboard API returned ${response.status}`);
  }

  const data = await response.json();
  services = data.services;
  latestLisa = data.lisa;
  renderLisa(data.lisa);
  renderHosts(data.publicHosts);
  renderSummary(data);
  renderServices();
}

async function loadLisaStatus() {
  const response = await fetch('/_dashboard/api', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Dashboard API returned ${response.status}`);
  }

  const data = await response.json();
  latestLisa = data.lisa;
  renderLisa(data.lisa);
}

function renderSummary(data) {
  const count = data.services.length;
  const plural = count === 1 ? 'servicio publicado' : 'servicios publicados';
  const ilicilabs = data.services.filter(service => service.origin === 'Ilicilabs').length;
  const others = count - ilicilabs;
  summaryEl.textContent = `${count} ${plural}: ${ilicilabs} Ilicilabs y ${others} externos al workspace.`;
}

function renderLisa(lisa) {
  lisaStatusEl.classList.toggle('deploying', lisa.deploying);
  lisaStatusEl.tabIndex = 0;
  lisaStatusEl.innerHTML = lisa.deploying
    ? '<span class="spinner" aria-hidden="true"></span><span>Desplegando: <strong></strong></span><div class="lisa-history" role="tooltip"></div>'
    : '<span class="status-dot" aria-hidden="true"></span><span>Lisa en reposo</span><div class="lisa-history" role="tooltip"></div>';

  if (lisa.deploying) {
    lisaStatusEl.querySelector('strong').textContent = lisa.application;
  }

  renderLisaHistory(lisa.history ?? []);
}

function renderLisaHistory(history) {
  const tooltip = lisaStatusEl.querySelector('.lisa-history');
  tooltip.replaceChildren();

  const title = document.createElement('p');
  title.className = 'history-title';
  title.textContent = 'Últimos despliegues';
  tooltip.append(title);

  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'Sin eventos recientes';
    tooltip.append(empty);
    return;
  }

  const list = document.createElement('ol');
  for (const event of history.slice(0, 6)) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = event.timestamp;
    time.textContent = formatEventTime(event.timestamp);
    const message = document.createElement('span');
    message.textContent = event.message;
    item.append(time, message);
    list.append(item);
  }
  tooltip.append(list);
}

function formatEventTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderHosts(hosts) {
  hostListEl.replaceChildren();

  for (const host of hosts) {
    const pill = document.createElement('span');
    pill.className = 'host-pill';
    pill.textContent = host;
    hostListEl.append(pill);
  }
}

function renderServices() {
  const query = searchEl.value.trim().toLowerCase();
  const filtered = services.filter(service =>
    [service.name, service.path, service.kind, service.origin, service.upstream]
      .filter(Boolean)
      .some(value => value.toLowerCase().includes(query)));

  servicesEl.replaceChildren(...renderServiceGroups(filtered));
  emptyEl.hidden = filtered.length > 0;
}

function renderServiceGroups(serviceList) {
  const groups = [
    ['Ilicilabs', serviceList.filter(service => service.origin === 'Ilicilabs')],
    ['Otros servicios', serviceList.filter(service => service.origin !== 'Ilicilabs')]
  ];

  return groups
    .filter(([, groupServices]) => groupServices.length > 0)
    .map(([title, groupServices]) => {
      const section = document.createElement('section');
      section.className = 'service-group';

      const header = document.createElement('div');
      header.className = 'group-header';

      const heading = document.createElement('h2');
      heading.textContent = title;

      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = `${groupServices.length}`;

      const grid = document.createElement('div');
      grid.className = 'grid';
      grid.replaceChildren(...groupServices.map(renderServiceCard));

      header.append(heading, count);
      section.append(header, grid);
      return section;
    });
}

function renderServiceCard(service) {
  const card = document.createElement('article');
  card.className = 'service-card';

  const initial = document.createElement('div');
  initial.className = `service-icon ${service.kind.toLowerCase()}`;
  initial.textContent = service.name.charAt(0) || 'S';

  const content = document.createElement('div');
  content.className = 'service-content';

  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';

  const title = document.createElement('h2');
  title.textContent = service.name;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = service.kind === 'API' ? 'Swagger' : service.kind;

  titleRow.append(title, badge);

  const path = document.createElement('p');
  path.className = 'route';
  path.textContent = service.path;

  const meta = document.createElement('p');
  meta.className = 'meta';
  const target = service.kind === 'API' ? `Abre ${service.url}` : cleanUpstream(service.upstream ?? service.redirectTo);
  meta.textContent = `${service.origin} · ${target}`;

  const link = document.createElement('a');
  link.className = 'open-link';
  link.href = service.url;
  link.textContent = service.kind === 'API' ? 'Swagger' : 'Abrir';
  link.setAttribute('aria-label', `Abrir ${service.name}`);

  content.append(titleRow, path, meta, link);
  card.append(initial, content);
  return card;
}

function cleanUpstream(upstream) {
  return upstream.replace(/^https?:\/\//, '');
}

searchEl.addEventListener('input', renderServices);

loadDashboard().catch(error => {
  summaryEl.textContent = 'No se pudo cargar el dashboard.';
  servicesEl.innerHTML = `<p class="error">${error.message}</p>`;
});

setInterval(() => {
  loadLisaStatus().catch(() => renderLisa(latestLisa));
}, 2000);
setInterval(loadDashboard, 30000);

const servicesEl = document.querySelector('#services');
const emptyEl = document.querySelector('#empty');
const searchEl = document.querySelector('#search');
const summaryEl = document.querySelector('#summary');
const lisaStatusEl = document.querySelector('#lisaStatus');
const hostListEl = document.querySelector('#hostList');

let services = [];

async function loadDashboard() {
  const response = await fetch('/_dashboard/api', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Dashboard API returned ${response.status}`);
  }

  const data = await response.json();
  services = data.services;
  renderLisa(data.lisa);
  renderHosts(data.publicHosts);
  renderSummary(data);
  renderServices();
}

function renderSummary(data) {
  const count = data.services.length;
  const plural = count === 1 ? 'servicio publicado' : 'servicios publicados';
  summaryEl.textContent = `${count} ${plural} desde la configuración activa de Nginx.`;
}

function renderLisa(lisa) {
  lisaStatusEl.classList.toggle('deploying', lisa.deploying);
  lisaStatusEl.innerHTML = lisa.deploying
    ? '<span class="spinner" aria-hidden="true"></span><span>Desplegando: <strong></strong></span>'
    : '<span class="status-dot" aria-hidden="true"></span><span>Lisa en reposo</span>';

  if (lisa.deploying) {
    lisaStatusEl.querySelector('strong').textContent = lisa.application;
  }
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
    [service.name, service.path, service.kind, service.upstream]
      .filter(Boolean)
      .some(value => value.toLowerCase().includes(query)));

  servicesEl.replaceChildren(...filtered.map(renderServiceCard));
  emptyEl.hidden = filtered.length > 0;
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
  badge.textContent = service.kind;

  titleRow.append(title, badge);

  const path = document.createElement('p');
  path.className = 'route';
  path.textContent = service.path;

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = service.upstream ? cleanUpstream(service.upstream) : `Redirige a ${service.redirectTo}`;

  const link = document.createElement('a');
  link.className = 'open-link';
  link.href = service.url;
  link.textContent = 'Abrir';
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

setInterval(loadDashboard, 15000);

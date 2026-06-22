const servicesEl = document.querySelector('#services');
const emptyEl = document.querySelector('#empty');
const searchEl = document.querySelector('#search');
const summaryEl = document.querySelector('#summary');
const lisaStatusEl = document.querySelector('#lisaStatus');
const lisaDeploymentDialogEl = document.querySelector('#lisaDeploymentDialog');
const lisaDeploymentBodyEl = document.querySelector('#lisaDeploymentBody');
const lisaDeploymentCloseEl = document.querySelector('#lisaDeploymentClose');

let services = [];
let latestLisa = {
  status: 'offline',
  available: false,
  deploying: false,
  application: null,
  history: []
};
let lisaExpressionTimer = null;
let lisaExpressionResetTimer = null;
let lisaExpressionActive = false;
let lisaPointerTracking = false;

const lisaPersonalityDelay = {
  firstMin: 3200,
  firstRange: 2200,
  loopMin: 5200,
  loopRange: 7800
};
const lisaPreviewMode = new URLSearchParams(window.location.search).get('previewLisa');
let lisaPreviewOverride = lisaPreviewMode;

const lisaExpressionClasses = [
  'is-looking',
  'is-smiling-wide',
  'is-wink-left',
  'is-wink-right',
  'is-curious',
  'is-sleepy',
  'is-happy-hop',
  'is-listening',
  'is-laughing'
];

const lisaLooks = [
  { x: '-3px', y: '-1px', classes: ['is-listening'], duration: 1250 },
  { x: '3px', y: '-1px', classes: ['is-smiling-wide'], duration: 1350 },
  { x: '0px', y: '-2px', classes: ['is-curious'], duration: 1450 },
  { x: '-2px', y: '1px', wink: 'left', classes: ['is-smiling-wide'], duration: 1150 },
  { x: '2px', y: '1px', wink: 'right', classes: ['is-smiling-wide'], duration: 1150 },
  { x: '0px', y: '2px', classes: ['is-sleepy'], duration: 1500 },
  { x: '0px', y: '-1px', classes: ['is-happy-hop', 'is-smiling-wide'], duration: 1300 },
  { x: '0px', y: '-1px', classes: ['is-laughing'], duration: 1500 }
];

window.setTimeout(() => {
  document.body.classList.remove('intro-running');
  document.body.classList.add('intro-handoff');

  window.setTimeout(() => {
    document.body.classList.remove('intro-handoff');
    document.body.classList.add('intro-played');
  }, 1900);
}, 2600);

async function loadDashboard() {
  const response = await fetch('/_dashboard/api', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Dashboard API returned ${response.status}`);
  }

  const data = await response.json();
  const lisa = applyLisaPreview(data.lisa);
  services = data.services;
  latestLisa = lisa;
  if (!lisaPointerTracking && !lisaExpressionActive) {
    renderLisa(lisa);
  }
  renderSummary(data);
  renderServices();
}

async function loadLisaStatus() {
  const response = await fetch('/_dashboard/api', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Dashboard API returned ${response.status}`);
  }

  const data = await response.json();
  latestLisa = applyLisaPreview(data.lisa);
  if (!lisaPointerTracking && !lisaExpressionActive) {
    renderLisa(latestLisa);
  }
}

function applyLisaPreview(lisa) {
  if (lisaPreviewOverride !== 'working') {
    return lisa;
  }

  return createLisaWorkingPreview(lisa);
}

function createLisaWorkingPreview(lisa = {}) {
  return {
    ...lisa,
    status: 'working',
    available: true,
    deploying: true,
    application: 'preview-lisa',
    deploymentPhases: [
      { name: 'Preparando', status: 'done', detail: 'Backup de configuración' },
      { name: 'Inspección', status: 'current', detail: 'Compatibilidad de datos' },
      { name: 'Reconstrucción', status: 'pending', detail: 'Pendiente de ejecución' }
    ],
    history: [
      {
        timestamp: new Date().toISOString(),
        message: 'Lisa está preparando una vista previa de trabajo.'
      },
      ...(lisa.history ?? [])
    ]
  };
}

function createLisaOffline(reason = 'request_failed') {
  return {
    status: 'offline',
    available: false,
    deploying: false,
    application: null,
    reason,
    history: []
  };
}

function renderSummary(data) {
  const total = data.services.length;
  const ilicilabs = data.services.filter(service => service.origin === 'Ilicilabs').length;
  const external = total - ilicilabs;
  const items = [
    ['Total', total],
    ['Ilicilabs', ilicilabs],
    ['Externos', external]
  ];

  summaryEl.replaceChildren(...items.map(([label, value]) => {
    const metric = document.createElement('article');
    metric.className = 'metric';

    const labelEl = document.createElement('span');
    labelEl.textContent = label;

    const valueEl = document.createElement('strong');
    valueEl.textContent = String(value);

    metric.append(labelEl, valueEl);
    return metric;
  }));
}

function renderLisa(lisa) {
  const status = lisa.status ?? (lisa.deploying ? 'working' : 'idle');
  const canOpenDeployment = status === 'working';
  const statusClasses = status === 'working'
    ? 'deploying is-live is-working'
    : status === 'offline'
      ? 'is-offline'
      : 'is-idle';

  lisaStatusEl.className = `status-panel lisa-mascot ${statusClasses}`;
  lisaStatusEl.tabIndex = 0;
  lisaStatusEl.setAttribute('role', canOpenDeployment ? 'button' : 'status');
  lisaStatusEl.setAttribute('aria-label', lisaAriaLabel(lisa, status));
  if (canOpenDeployment) {
    lisaStatusEl.setAttribute('aria-haspopup', 'dialog');
    lisaStatusEl.setAttribute('aria-expanded', String(lisaDeploymentDialogEl?.open));
  } else {
    lisaStatusEl.removeAttribute('aria-haspopup');
    lisaStatusEl.removeAttribute('aria-expanded');
  }
  lisaStatusEl.replaceChildren();

  const bot = document.createElement('div');
  bot.className = 'lisa-bot';
  bot.setAttribute('aria-hidden', 'true');

  const antenna = document.createElement('span');
  antenna.className = 'lisa-antenna';

  const face = document.createElement('div');
  face.className = 'lisa-face';

  const leftEye = document.createElement('span');
  leftEye.className = 'lisa-eye lisa-eye-left';

  const rightEye = document.createElement('span');
  rightEye.className = 'lisa-eye lisa-eye-right';

  const leftCheek = document.createElement('span');
  leftCheek.className = 'lisa-cheek lisa-cheek-left';

  const rightCheek = document.createElement('span');
  rightCheek.className = 'lisa-cheek lisa-cheek-right';

  const mouth = document.createElement('span');
  mouth.className = 'lisa-mouth';

  const workPulse = document.createElement('span');
  workPulse.className = 'lisa-work-pulse';

  face.append(leftEye, rightEye, leftCheek, rightCheek, mouth, workPulse);
  bot.append(antenna, face);

  const copy = document.createElement('div');
  copy.className = 'lisa-copy';

  const name = document.createElement('span');
  name.className = 'lisa-name';
  name.textContent = 'Lisa';

  const state = document.createElement('span');
  state.className = 'lisa-state';
  state.textContent = lisaStateText(lisa, status);

  const tooltip = document.createElement('div');
  tooltip.className = 'lisa-history';
  tooltip.setAttribute('role', 'tooltip');

  copy.append(name, state);
  lisaStatusEl.append(bot, copy, tooltip);
  lisaStatusEl.onpointerenter = startLisaPointerTracking;
  lisaStatusEl.onpointermove = updateLisaPointerTracking;
  lisaStatusEl.onpointerleave = stopLisaPointerTracking;
  lisaStatusEl.onpointercancel = stopLisaPointerTracking;
  lisaStatusEl.onclick = canOpenDeployment ? openLisaDeploymentDialog : null;
  lisaStatusEl.onkeydown = canOpenDeployment ? handleLisaStatusKeydown : null;
  lisaStatusEl.onfocus = null;

  renderLisaHistory(lisa);
  renderLisaDeploymentDialog(lisa);
  if (!canOpenDeployment && lisaDeploymentDialogEl?.open) {
    lisaDeploymentDialogEl.close();
  }
  if (status === 'offline') {
    stopLisaExpressionLoop();
  } else {
    startLisaExpressionLoop();
  }
}

function lisaAriaLabel(lisa, status) {
  if (status === 'working') {
    return `Lisa live, desplegando ${lisa.application || 'aplicación'}. Abrir fases del despliegue actual.`;
  }

  if (status === 'offline') {
    return 'Lisa offline, no se pudo leer el estado local';
  }

  return 'Lisa en reposo';
}

function lisaStateText(lisa, status) {
  if (status === 'working') {
    return `Live: ${lisa.application || 'despliegue activo'}`;
  }

  if (status === 'offline') {
    return 'Offline';
  }

  return 'En reposo';
}

function renderLisaHistory(lisa) {
  const tooltip = lisaStatusEl.querySelector('.lisa-history');
  const history = lisa.history ?? [];
  const status = lisa.status ?? (lisa.deploying ? 'working' : 'idle');
  tooltip.replaceChildren();

  const title = document.createElement('p');
  title.className = 'history-title';
  title.textContent = status === 'offline' ? 'Lisa sin conexión' : 'Últimos despliegues';
  tooltip.append(title);

  if (status === 'offline') {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = lisa.reason === 'missing_state'
      ? 'No se encontró el state.json local de Lisa.'
      : 'No se pudo leer el estado local de Lisa.';
    tooltip.append(empty);
    return;
  }

  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'Sin despliegues registrados';
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

function handleLisaStatusKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }

  event.preventDefault();
  openLisaDeploymentDialog();
}

function openLisaDeploymentDialog() {
  if (!lisaDeploymentDialogEl || !latestLisa.deploying) {
    return;
  }

  renderLisaDeploymentDialog(latestLisa);
  lisaDeploymentDialogEl.showModal();
  lisaStatusEl.setAttribute('aria-expanded', 'true');
}

function closeLisaDeploymentDialog() {
  if (!lisaDeploymentDialogEl?.open) {
    return;
  }

  lisaDeploymentDialogEl.close();
}

function renderLisaDeploymentDialog(lisa) {
  if (!lisaDeploymentBodyEl) {
    return;
  }

  lisaDeploymentBodyEl.replaceChildren();

  const application = document.createElement('p');
  application.className = 'deployment-app';
  application.textContent = `Desplegando: ${lisa.application || 'aplicación'}`;

  const phases = normalizeLisaDeploymentPhases(lisa);
  const list = document.createElement('ol');
  list.className = 'deployment-phases';

  for (const phase of phases) {
    const item = document.createElement('li');
    item.className = `deployment-phase is-${phase.status}`;

    const marker = document.createElement('span');
    marker.className = 'phase-marker';
    marker.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('span');
    copy.className = 'phase-copy';

    const name = document.createElement('strong');
    name.textContent = phase.name;

    const detail = document.createElement('span');
    detail.textContent = phase.detail || lisaPhaseStatusText(phase.status);

    copy.append(name, detail);
    item.append(marker, copy);
    list.append(item);
  }

  lisaDeploymentBodyEl.append(application, list);
}

function normalizeLisaDeploymentPhases(lisa) {
  const source =
    lisa.deploymentPhases ??
    lisa.phases ??
    lisa.currentDeployment?.phases ??
    lisa.deployment?.phases ??
    lisa.activeDeployment?.phases ??
    lisa.progress?.phases;

  if (!Array.isArray(source) || source.length === 0) {
    return [
      {
        name: lisa.application || 'Despliegue activo',
        status: 'current',
        detail: 'Lisa está desplegando esta aplicación.'
      }
    ];
  }

  return source.map((phase, index) => {
    if (typeof phase === 'string') {
      return {
        name: phase,
        status: index === 0 ? 'current' : 'pending',
        detail: ''
      };
    }

    const rawStatus = String(phase.status ?? phase.state ?? '').toLowerCase();
    return {
      name: phase.name ?? phase.title ?? phase.label ?? `Fase ${index + 1}`,
      status: normalizeLisaPhaseStatus(rawStatus),
      detail: phase.detail ?? phase.description ?? phase.message ?? ''
    };
  });
}

function normalizeLisaPhaseStatus(status) {
  if (['done', 'completed', 'complete', 'success', 'hecha'].includes(status)) {
    return 'done';
  }

  if (['current', 'active', 'running', 'in_progress', 'now', 'ahora'].includes(status)) {
    return 'current';
  }

  if (['failed', 'error', 'danger'].includes(status)) {
    return 'failed';
  }

  return 'pending';
}

function lisaPhaseStatusText(status) {
  if (status === 'done') return 'Hecha';
  if (status === 'current') return 'Ahora';
  if (status === 'failed') return 'Error';
  return 'Pendiente';
}

function startLisaExpressionLoop() {
  if (lisaPointerTracking || lisaExpressionTimer || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  const tick = () => {
    const expression = lisaLooks[Math.floor(Math.random() * lisaLooks.length)];
    playLisaExpression(expression);
    lisaExpressionTimer = window.setTimeout(
      tick,
      lisaPersonalityDelay.loopMin + Math.random() * lisaPersonalityDelay.loopRange
    );
  };

  lisaExpressionTimer = window.setTimeout(
    tick,
    lisaPersonalityDelay.firstMin + Math.random() * lisaPersonalityDelay.firstRange
  );
}

function stopLisaExpressionLoop() {
  window.clearTimeout(lisaExpressionTimer);
  window.clearTimeout(lisaExpressionResetTimer);
  lisaExpressionTimer = null;
  lisaExpressionResetTimer = null;
  lisaExpressionActive = false;
}

function clearLisaExpression(bot = lisaStatusEl.querySelector('.lisa-bot')) {
  if (!bot) return;

  bot.classList.remove(...lisaExpressionClasses);
}

function resetLisaLook(bot = lisaStatusEl.querySelector('.lisa-bot')) {
  if (!bot) return;

  bot.style.setProperty('--look-x', '0px');
  bot.style.setProperty('--look-y', '0px');
}

function startLisaPointerTracking(event) {
  if (event.pointerType && event.pointerType !== 'mouse') {
    return;
  }

  lisaPointerTracking = true;
  stopLisaExpressionLoop();
  clearLisaExpression();
  lisaStatusEl.classList.add('is-pointer-tracking');
  updateLisaPointerTracking(event);
}

function updateLisaPointerTracking(event) {
  if (!lisaPointerTracking || (event.pointerType && event.pointerType !== 'mouse')) {
    return;
  }

  const bot = lisaStatusEl.querySelector('.lisa-bot');
  const face = lisaStatusEl.querySelector('.lisa-face');
  if (!bot || !face) {
    return;
  }

  const rect = face.getBoundingClientRect();
  const relativeX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
  const relativeY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  const lookX = clamp(relativeX, -1, 1) * 5;
  const lookY = clamp(relativeY, -1, 1) * 4;

  clearLisaExpression(bot);
  bot.style.setProperty('--look-x', `${lookX.toFixed(2)}px`);
  bot.style.setProperty('--look-y', `${lookY.toFixed(2)}px`);
}

function stopLisaPointerTracking(event) {
  if (event.pointerType && event.pointerType !== 'mouse') {
    return;
  }

  lisaPointerTracking = false;
  lisaStatusEl.classList.remove('is-pointer-tracking');
  clearLisaExpression();
  resetLisaLook();
  startLisaExpressionLoop();
}

function playLisaExpression(expression = {}) {
  const bot = lisaStatusEl.querySelector('.lisa-bot');
  if (!bot) return;

  bot.classList.remove(...lisaExpressionClasses);
  bot.style.setProperty('--look-x', expression.x ?? '0px');
  bot.style.setProperty('--look-y', expression.y ?? '0px');
  bot.classList.add('is-looking');
  lisaExpressionActive = true;

  for (const className of expression.classes ?? []) {
    bot.classList.add(className);
  }

  if (expression.smile) {
    bot.classList.add('is-smiling-wide');
  }
  if (expression.wink === 'left') {
    bot.classList.add('is-wink-left');
  }
  if (expression.wink === 'right') {
    bot.classList.add('is-wink-right');
  }

  window.clearTimeout(lisaExpressionResetTimer);
  lisaExpressionResetTimer = window.setTimeout(() => {
    bot.classList.remove(...lisaExpressionClasses);
    bot.style.setProperty('--look-x', '0px');
    bot.style.setProperty('--look-y', '0px');
    lisaExpressionActive = false;
  }, expression.duration ?? 1250);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

window.__homelabDashboard = {
  playLisaExpression,
  previewLisaWorking: () => {
    lisaPreviewOverride = 'working';
    latestLisa = createLisaWorkingPreview({ history: [] });
    renderLisa(latestLisa);
  },
  lisaPersonalityCount: lisaLooks.length,
  lisaPersonalityDelay
};

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
      grid.className = 'grid service-table';
      grid.replaceChildren(...groupServices.map((service, index) => renderServiceCard(service, index)));

      header.append(heading, count);
      section.append(header, grid);
      return section;
    });
}

function renderServiceCard(service, index = 0) {
  const card = document.createElement('article');
  card.className = 'service-card';
  card.addEventListener('pointermove', handleServiceCardPointerMove);
  card.addEventListener('pointerleave', handleServiceCardPointerLeave);
  card.style.setProperty('--kind-color', serviceKindColor(service.kind));
  card.style.setProperty('--row-delay', `${Math.min(index, 12) * 45}ms`);

  const hoverBeam = document.createElement('span');
  hoverBeam.className = 'service-hover-beam';
  hoverBeam.setAttribute('aria-hidden', 'true');

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

  titleRow.append(title);

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

  content.append(titleRow, path, meta);
  card.append(hoverBeam, initial, content, badge, link);
  return card;
}

function handleServiceCardPointerMove(event) {
  if (event.pointerType !== 'mouse') {
    return;
  }

  const card = event.currentTarget;
  const rect = card.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;

  card.classList.add('is-tilting');
  card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
  card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
  card.style.setProperty('--rx', `${((0.5 - y) * 9).toFixed(2)}deg`);
  card.style.setProperty('--ry', `${((x - 0.5) * 12).toFixed(2)}deg`);
  card.style.setProperty('--icon-dx', `${((x - 0.5) * 7).toFixed(2)}px`);
  card.style.setProperty('--icon-dy', `${((y - 0.5) * 5).toFixed(2)}px`);
}

function handleServiceCardPointerLeave(event) {
  const card = event.currentTarget;
  card.classList.remove('is-tilting');
  card.style.setProperty('--mx', '50%');
  card.style.setProperty('--my', '50%');
  card.style.setProperty('--rx', '0deg');
  card.style.setProperty('--ry', '0deg');
  card.style.setProperty('--icon-dx', '0px');
  card.style.setProperty('--icon-dy', '0px');
}

function serviceKindColor(kind) {
  if (kind === 'API') return 'var(--warning)';
  if (kind === 'Host') return 'var(--accent)';
  return 'var(--primary)';
}

function cleanUpstream(upstream) {
  return upstream.replace(/^https?:\/\//, '');
}

searchEl.addEventListener('input', renderServices);
lisaDeploymentCloseEl?.addEventListener('click', closeLisaDeploymentDialog);
lisaDeploymentDialogEl?.addEventListener('close', () => {
  lisaStatusEl.setAttribute('aria-expanded', 'false');
  lisaStatusEl.focus();
});
lisaDeploymentDialogEl?.addEventListener('click', event => {
  if (event.target === lisaDeploymentDialogEl) {
    closeLisaDeploymentDialog();
  }
});

loadDashboard().catch(error => {
  summaryEl.textContent = 'No se pudo cargar el dashboard.';
  servicesEl.innerHTML = `<p class="error">${error.message}</p>`;
  renderLisa(createLisaOffline('request_failed'));
});

setInterval(() => {
  loadLisaStatus().catch(() => renderLisa(createLisaOffline('request_failed')));
}, 2000);
setInterval(loadDashboard, 30000);

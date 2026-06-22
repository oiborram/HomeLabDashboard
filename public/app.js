const servicesEl = document.querySelector('#services');
const emptyEl = document.querySelector('#empty');
const searchEl = document.querySelector('#search');
const summaryEl = document.querySelector('#summary');
const lisaStatusEl = document.querySelector('#lisaStatus');
const lisaDeploymentDialogEl = document.querySelector('#lisaDeploymentDialog');
const lisaDeploymentBodyEl = document.querySelector('#lisaDeploymentBody');
const lisaDeploymentCloseEl = document.querySelector('#lisaDeploymentClose');
const lisaDeploymentExpandEl = document.querySelector('#lisaDeploymentExpand');

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
let lastDeploymentLisa = null;
let lastDeploymentKey = null;
let lisaDeploymentTrackingReady = false;
let lisaWasDeploying = false;

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
  'is-soft-glow',
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
  { x: '0px', y: '-1px', classes: ['is-soft-glow'], duration: 1450 },
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
  trackLisaDeployment(lisa);
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
  trackLisaDeployment(latestLisa);
  if (!lisaPointerTracking && !lisaExpressionActive) {
    renderLisa(latestLisa);
  }
}

function trackLisaDeployment(lisa) {
  if (!lisaDeploymentTrackingReady) {
    lisaDeploymentTrackingReady = true;
    if (lisa?.deploying) {
      lastDeploymentLisa = structuredCloneLisa(lisa);
      lastDeploymentKey = lisaDeploymentKey(lisa);
    }
    lisaWasDeploying = Boolean(lisa?.deploying);
    return;
  }

  if (!lisa?.deploying) {
    if (lisaWasDeploying && lastDeploymentLisa) {
      lastDeploymentLisa = completeLisaDeploymentSnapshot(lastDeploymentLisa);
      if (lisaDeploymentDialogEl?.open) {
        renderLisaDeploymentDialog(lastDeploymentLisa);
      }
    }
    lisaWasDeploying = false;
    return;
  }

  const deploymentKey = lisaDeploymentKey(lisa);
  const isNewDeployment = deploymentKey !== lastDeploymentKey;
  lastDeploymentLisa = structuredCloneLisa(lisa);
  lastDeploymentKey = deploymentKey;

  if (isNewDeployment) {
    renderLisaDeploymentDialog(lastDeploymentLisa);
    if (lisaPreviewOverride !== 'working') {
      openLisaDeploymentDialog();
    }
  } else if (lisaDeploymentDialogEl?.open) {
    renderLisaDeploymentDialog(lastDeploymentLisa);
  }
  lisaWasDeploying = true;
}

function lisaDeploymentKey(lisa) {
  const deployment = lisa.deployment ?? {};
  return [
    deployment.repository ?? '',
    deployment.commitSha ?? '',
    deployment.startedAtUtc ?? '',
    deployment.application ?? lisa.application ?? '',
    deployment.route ?? ''
  ].join('|');
}

function structuredCloneLisa(lisa) {
  return JSON.parse(JSON.stringify(lisa));
}

function completeLisaDeploymentSnapshot(lisa) {
  const snapshot = structuredCloneLisa(lisa);
  snapshot.status = 'idle';
  snapshot.deploying = false;
  snapshot.deployment = {
    ...(snapshot.deployment ?? {}),
    phase: 'complete',
    phaseLabel: 'Completado',
    completedAtUtc: new Date().toISOString()
  };
  const phases = normalizeLisaDeploymentPhases(snapshot).map(phase => ({
    ...phase,
    status: 'done',
    detail: phase.status === 'current' ? 'Finalizado' : phase.detail
  }));
  snapshot.deployment.phases = phases;
  snapshot.deploymentPhases = phases;
  return snapshot;
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
    deployment: {
      application: 'preview-lisa',
      phase: 'post-deploy-agent',
      phaseLabel: 'Verificando con agente',
      updatedAtUtc: new Date().toISOString(),
      phases: [
        { id: 'starting', label: 'Preparando', status: 'done' },
        { id: 'backup', label: 'Backup de configuración', status: 'done' },
        { id: 'inspect', label: 'Inspección', status: 'done' },
        { id: 'database-backup', label: 'Backup de BBDD', status: 'done' },
        { id: 'manifest', label: 'Manifiesto', status: 'done' },
        { id: 'compose', label: 'Docker Compose', status: 'done' },
        { id: 'nginx', label: 'Rutas nginx', status: 'done' },
        { id: 'restart', label: 'Reconstrucción', status: 'done' },
        { id: 'post-deploy-agent', label: 'Verificación', status: 'current' },
        { id: 'complete', label: 'Completado', status: 'pending' }
      ]
    },
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
  const hasDeploymentPanel = status === 'working' || lastDeploymentLisa !== null;
  const statusClasses = status === 'working'
    ? 'deploying is-live is-working'
    : status === 'offline'
      ? 'is-offline'
      : 'is-idle';

  lisaStatusEl.className = `status-panel lisa-mascot ${statusClasses}`;
  lisaStatusEl.tabIndex = 0;
  lisaStatusEl.setAttribute('role', hasDeploymentPanel ? 'button' : 'status');
  lisaStatusEl.setAttribute('aria-label', lisaAriaLabel(lisa, status));
  if (hasDeploymentPanel) {
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
  renderLisaState(state, lisa, status);

  const tooltip = document.createElement('div');
  tooltip.className = 'lisa-history';
  tooltip.setAttribute('role', 'tooltip');

  copy.append(name, state);
  lisaStatusEl.append(bot, copy, tooltip);
  lisaStatusEl.onpointerenter = startLisaPointerTracking;
  lisaStatusEl.onpointermove = updateLisaPointerTracking;
  lisaStatusEl.onpointerleave = stopLisaPointerTracking;
  lisaStatusEl.onpointercancel = stopLisaPointerTracking;
  lisaStatusEl.onclick = hasDeploymentPanel ? openLisaDeploymentDialog : null;
  lisaStatusEl.onkeydown = hasDeploymentPanel ? handleLisaStatusKeydown : null;
  lisaStatusEl.onfocus = null;

  renderLisaHistory(lisa);
  if (lisa.deploying) {
    renderLisaDeploymentDialog(lastDeploymentLisa ?? lisa);
  } else if (lisaDeploymentDialogEl?.open && lastDeploymentLisa) {
    renderLisaDeploymentDialog(lastDeploymentLisa);
  }
  if (status === 'offline') {
    stopLisaExpressionLoop();
  } else {
    startLisaExpressionLoop();
  }
}

function lisaAriaLabel(lisa, status) {
  if (status === 'working') {
    const application = lisa.deployment?.application || lisa.application || 'aplicación';
    const phase = lisa.deployment?.phaseLabel || 'despliegue en curso';
    return `Lisa desplegando ${application}: ${phase}. Abrir fases del despliegue actual.`;
  }

  if (lastDeploymentLisa) {
    const application = lisaDeploymentAppText(lastDeploymentLisa);
    return `Lisa en reposo. Abrir último despliegue registrado en esta página: ${application}.`;
  }

  if (status === 'offline') {
    return 'Lisa offline, no se pudo leer el estado local';
  }

  return 'Lisa en reposo';
}

function renderLisaState(stateEl, lisa, status) {
  stateEl.replaceChildren();

  if (status === 'working') {
    const label = document.createElement('span');
    label.className = 'lisa-state-label';
    label.textContent = 'Desplegando:';

    const app = document.createElement('strong');
    app.className = 'lisa-state-app';
    app.textContent = lisaDeploymentAppText(lisa);

    const phase = document.createElement('span');
    phase.className = 'lisa-state-phase';
    phase.textContent = lisa.deployment?.phaseLabel || 'despliegue en curso';

    stateEl.append(label, app, phase);
    return;
  }

  if (status === 'offline') {
    stateEl.textContent = 'Offline';
    return;
  }

  stateEl.textContent = 'En reposo';
}

function lisaDeploymentAppText(lisa) {
  return lisa.deployment?.application || lisa.application || 'aplicación';
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
  for (const event of history.slice(0, 3)) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = event.timestamp;
    const formatted = formatEventParts(event.timestamp);
    const datePart = document.createElement('span');
    datePart.className = 'history-date';
    datePart.textContent = formatted.date;
    const timePart = document.createElement('span');
    timePart.className = 'history-clock';
    timePart.textContent = formatted.time;
    time.append(datePart, timePart);
    const message = document.createElement('span');
    message.className = 'history-message';
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
  if (!lisaDeploymentDialogEl) {
    return;
  }

  const deploymentLisa = latestLisa.deploying ? latestLisa : lastDeploymentLisa;
  if (!deploymentLisa) {
    return;
  }

  renderLisaDeploymentDialog(deploymentLisa);
  setLisaDialogOrigin();
  if (!lisaDeploymentDialogEl.open) {
    lisaDeploymentDialogEl.showModal();
  }
  lisaStatusEl.setAttribute('aria-expanded', 'true');
}

function setLisaDialogOrigin() {
  if (!lisaDeploymentDialogEl) {
    return;
  }

  const rect = lisaStatusEl.getBoundingClientRect();
  lisaDeploymentDialogEl.style.setProperty('--origin-x', `${rect.left + rect.width / 2}px`);
  lisaDeploymentDialogEl.style.setProperty('--origin-y', `${rect.top + rect.height / 2}px`);
}

function closeLisaDeploymentDialog() {
  if (!lisaDeploymentDialogEl?.open) {
    return;
  }

  lisaDeploymentDialogEl.close();
}

function toggleLisaDeploymentExpanded() {
  if (!lisaDeploymentDialogEl) {
    return;
  }

  const expanded = !lisaDeploymentDialogEl.classList.contains('is-expanded');
  lisaDeploymentDialogEl.classList.toggle('is-expanded', expanded);
  lisaDeploymentExpandEl?.setAttribute('aria-pressed', String(expanded));
  lisaDeploymentExpandEl?.setAttribute(
    'aria-label',
    expanded ? 'Contraer panel de despliegue' : 'Expandir panel de despliegue'
  );
  if (lisaDeploymentExpandEl) {
    lisaDeploymentExpandEl.textContent = expanded ? 'Contraer' : 'Expandir';
  }
}

function renderLisaDeploymentDialog(lisa) {
  if (!lisaDeploymentBodyEl) {
    return;
  }

  lisaDeploymentBodyEl.replaceChildren();

  const deployment = lisa.deployment ?? null;
  const applicationName = lisaDeploymentAppText(lisa);
  const application = document.createElement('p');
  application.className = 'deployment-app';
  const applicationLabel = document.createElement('span');
  applicationLabel.textContent = lisa.deploying ? 'Desplegando' : 'Último despliegue';
  const applicationValue = document.createElement('strong');
  applicationValue.textContent = applicationName;
  application.append(applicationLabel, applicationValue);

  const phases = normalizeLisaDeploymentPhases(lisa);
  const currentPhaseIndex = phases.findIndex(phase => phase.status === 'current');
  const lastDoneIndex = phases.reduce((lastIndex, phase, index) => phase.status === 'done' ? index : lastIndex, -1);
  const progressIndex = Math.max(0, currentPhaseIndex >= 0 ? currentPhaseIndex : lastDoneIndex);
  const progress = document.createElement('div');
  progress.className = 'deployment-progress';
  progress.setAttribute('aria-hidden', 'true');
  progress.style.setProperty('--phase-progress', `${phases.length > 1 ? progressIndex / (phases.length - 1) : 1}`);

  const list = document.createElement('ol');
  list.className = 'deployment-phases';

  for (const [index, phase] of phases.entries()) {
    const item = document.createElement('li');
    item.className = `deployment-phase is-${phase.status}`;
    item.style.setProperty('--phase-index', String(index));

    const marker = document.createElement('span');
    marker.className = 'phase-marker';
    marker.textContent = phase.status === 'done' ? '✓' : String(index + 1);
    marker.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('span');
    copy.className = 'phase-copy';

    const name = document.createElement('strong');
    name.textContent = phase.name;

    const state = document.createElement('span');
    state.className = 'phase-state';
    state.textContent = lisaPhaseStatusText(phase.status);

    copy.append(name);
    if (phase.detail) {
      const detail = document.createElement('span');
      detail.textContent = phase.detail;
      copy.append(detail);
    }
    item.append(marker, copy);
    item.append(state);
    list.append(item);
  }

  lisaDeploymentBodyEl.append(application, progress, list);
}

function normalizeLisaDeploymentPhases(lisa) {
  const source =
    lisa.deployment?.phases ??
    lisa.deploymentPhases ??
    lisa.phases ??
    lisa.currentDeployment?.phases ??
    lisa.activeDeployment?.phases ??
    lisa.progress?.phases;

  if (!Array.isArray(source) || source.length === 0) {
    return [
      {
        name: lisa.deployment?.phaseLabel || lisa.application || 'Despliegue activo',
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
      detail: phase.detail ?? phase.description ?? phase.message ?? phase.phaseLabel ?? ''
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
  const parts = formatEventParts(timestamp);
  return [parts.date, parts.time].filter(Boolean).join(' ');
}

function formatEventParts(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return { date: '', time: '' };
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');

  return {
    date: `${day}/${month}`,
    time: `${hour}:${minute}`
  };
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
lisaDeploymentExpandEl?.addEventListener('click', toggleLisaDeploymentExpanded);
lisaDeploymentDialogEl?.addEventListener('close', () => {
  lisaStatusEl.setAttribute('aria-expanded', 'false');
  lisaDeploymentDialogEl.classList.remove('is-expanded');
  lisaDeploymentExpandEl?.setAttribute('aria-pressed', 'false');
  lisaDeploymentExpandEl?.setAttribute('aria-label', 'Expandir panel de despliegue');
  if (lisaDeploymentExpandEl) {
    lisaDeploymentExpandEl.textContent = 'Expandir';
  }
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

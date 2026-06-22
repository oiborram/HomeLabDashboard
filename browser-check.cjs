const { chromium } = require('playwright');
const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8443/';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];

  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(dashboardUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  });
  await page.waitForTimeout(300);
  const intro = await page.evaluate(() => ({
    running: document.body.classList.contains('intro-running'),
    title: document.querySelector('.intro-title strong')?.textContent?.trim(),
    titleColor: getComputedStyle(document.querySelector('.intro-title strong')).color,
    animations: document.getAnimations({ subtree: true })
      .map(animation => animation.animationName)
      .filter(Boolean)
  }));

  if (!intro.running || intro.title !== 'Servicios disponibles' || !intro.animations.some(name => name.startsWith('adrian'))) {
    throw new Error(`Intro contract failed: ${JSON.stringify(intro)}`);
  }
  if (!isLightRgb(intro.titleColor)) {
    throw new Error(`Intro title must stay light during blue/black transition: ${JSON.stringify(intro)}`);
  }

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1400);
  const introStillRunning = await page.evaluate(() => document.body.classList.contains('intro-running'));
  if (!introStillRunning) {
    throw new Error('Intro finished too quickly.');
  }
  const earlyHandoff = await page.evaluate(() =>
    document.getAnimations({ subtree: true })
      .map(animation => animation.animationName)
      .filter(name => ['rightFrontShell', 'rightFrontElement', 'rightFrontRow'].includes(name)));
  if (earlyHandoff.length > 0) {
    throw new Error(`Main elements started before intro finished: ${JSON.stringify(earlyHandoff)}`);
  }

  await page.waitForTimeout(1300);
  const handoff = await page.evaluate(() =>
    ({
      active: document.body.classList.contains('intro-handoff'),
      animations: document.getAnimations({ subtree: true })
        .map(animation => animation.animationName)
        .filter(Boolean)
    }));
  if (!handoff.active || !handoff.animations.some(name => ['rightFrontShell', 'rightFrontElement', 'rightFrontRow'].includes(name))) {
    throw new Error(`Main right-to-front handoff animation missing: ${JSON.stringify(handoff)}`);
  }
  await page.waitForTimeout(2100);
  const overlayState = await page.evaluate(() => {
    const intro = document.querySelector('.intro-sequence');
    const style = intro ? getComputedStyle(intro) : null;
    return {
      running: document.body.classList.contains('intro-running'),
      handoff: document.body.classList.contains('intro-handoff'),
      visible: style?.visibility,
      opacity: style?.opacity
    };
  });
  if (overlayState.running || overlayState.handoff || overlayState.visible !== 'hidden' || Number(overlayState.opacity) > 0.02) {
    throw new Error(`Intro overlay did not hand off cleanly: ${JSON.stringify(overlayState)}`);
  }

  const title = await page.title();
  const h1 = await page.locator('h1').innerText();
  const summary = await page.locator('#summary').innerText();
  const cards = await page.locator('.service-card').count();
  const lisa = await page.locator('#lisaStatus').innerText();
  const links = await page.$$eval('.open-link', elements =>
    elements.map(anchor => ({
      text: anchor.textContent.trim(),
      href: anchor.getAttribute('href')
    })));
  const groups = await page.$$eval('.service-group', elements =>
    elements.map(section => section.querySelector('h2').textContent.trim()));
  const api = await page.evaluate(async () =>
    fetch('/_dashboard/api').then(response => response.json()));

  const firstService = api.services[0];
  const expectedWebService = api.services.find(service => service.kind !== 'API');
  const expectedApiService = api.services.find(service => service.kind === 'API');

  await page.locator('input[type="search"]').fill(firstService.name);
  const filtered = await page.locator('.service-card').count();
  const hostTags = await page.locator('.host-pill').count();
  const mojibake = await page.evaluate(() => {
    const visibleText = document.body.innerText;
    const internalText = [...document.querySelectorAll('[aria-label], .lisa-history')]
      .map(element => `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`)
      .join(' ');
    return /(?:\u00c3|\u00c2|\u00e2\u008c|\ufffd)/u.test(`${visibleText} ${internalText}`);
  });
  const summaryLabels = await page.$$eval('#summary .metric span', elements =>
    elements.map(element => element.textContent.trim()));

  if (title !== 'HomeLab Dashboard') {
    throw new Error(`Unexpected title: ${title}`);
  }
  if (h1 !== 'Servicios disponibles') {
    throw new Error(`Unexpected h1: ${h1}`);
  }
  if (cards < 5) {
    throw new Error(`Expected at least 5 service cards, got ${cards}`);
  }
  if (api.services.length !== cards) {
    throw new Error(`API/card mismatch: ${api.services.length} vs ${cards}`);
  }
  if (mojibake) {
    throw new Error('Mojibake was rendered.');
  }
  if (expectedWebService && !links.some(link => link.href === expectedWebService.url)) {
    throw new Error(`${expectedWebService.name} link was not rendered.`);
  }
  if (expectedApiService && !links.some(link => link.href === expectedApiService.url)) {
    throw new Error(`${expectedApiService.name} API link was not rendered.`);
  }
  if (!groups.includes('Ilicilabs') || !groups.includes('Otros servicios')) {
    throw new Error(`Expected both service groups, got ${groups.join(', ')}`);
  }
  if (filtered < 1) {
    throw new Error('Search did not keep Daria visible.');
  }
  if (hostTags !== 0) {
    throw new Error(`Host tags should not render below the filter, got ${hostTags}.`);
  }
  if (summaryLabels.includes('Hosts')) {
    throw new Error(`Hosts metric should not render in summary: ${summaryLabels.join(', ')}`);
  }
  if (!['offline', 'idle', 'working'].includes(api.lisa?.status)) {
    throw new Error(`Unexpected Lisa status contract: ${JSON.stringify(api.lisa)}`);
  }
  if (api.lisa.status !== 'offline' && !api.lisa.available) {
    throw new Error(`Lisa cannot be unavailable outside offline mode: ${JSON.stringify(api.lisa)}`);
  }
  if (api.lisa.available && api.lisa.history.length > 0 && !api.lisa.history[0].message.includes('Desplegado ')) {
    throw new Error(`Lisa deployment history was not normalized: ${JSON.stringify(api.lisa.history)}`);
  }
  if (errors.length > 0) {
    throw new Error(`Browser console errors: ${errors.join(' | ')}`);
  }

  const desktopLayout = await auditLayout(page, 'desktop');
  const lisaExpression = await probeLisaExpression(page);
  const lisaLaugh = await probeLisaLaugh(page);
  const lisaWorking = await probeLisaWorking(page);
  const lisaHoverTracking = await probeLisaHoverTracking(page);
  const lisaHistoryLayer = await probeLisaHistoryLayer(page);
  const hoverProbe = await probeServiceHover(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const mobileLayout = await auditLayout(page, 'mobile');

  console.log(JSON.stringify({
    title,
    h1,
    summary,
    cards,
    lisa,
    links,
    groups,
    apiHosts: api.publicHosts,
    filtered,
    firstService: firstService.name,
    mojibake,
    desktopLayout,
    lisaExpression,
    lisaLaugh,
    lisaWorking,
    lisaHoverTracking,
    lisaHistoryLayer,
    hoverProbe,
    mobileLayout,
    errors
  }, null, 2));

  await browser.close();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});

async function auditLayout(page, mode) {
  const result = await page.evaluate((mode) => {
    const root = document.documentElement;
    const search = document.querySelector('.search-wrap')?.getBoundingClientRect();
    const summary = document.querySelector('#summary')?.getBoundingClientRect();
    const lisa = document.querySelector('#lisaStatus')?.getBoundingClientRect();
    const hero = document.querySelector('.hero')?.getBoundingClientRect();
    const services = document.querySelector('#services')?.getBoundingClientRect();
    const table = document.querySelector('.service-table');
    const tableStyle = table ? getComputedStyle(table) : null;
    const card = document.querySelector('.service-card');
    const cardStyle = card ? getComputedStyle(card) : null;
    const lineField = document.querySelector('.line-field');
    const lineFieldStyle = lineField ? getComputedStyle(lineField) : null;
    const bodyBeforeStyle = getComputedStyle(document.body, '::before');
    const cardHeights = [...document.querySelectorAll('.service-card')]
      .slice(0, 4)
      .map(element => element.getBoundingClientRect().height);
    const linkStyle = document.querySelector('.open-link')
      ? getComputedStyle(document.querySelector('.open-link'))
      : null;
    const animations = document.getAnimations({ subtree: true })
      .map(animation => animation.animationName)
      .filter(Boolean);

    const mobileOrder =
      search && summary && services &&
      search.top <= summary.top &&
      summary.top <= services.top;
    const desktopAligned =
      search && summary &&
      Math.abs(search.top - summary.top) < 4;
    const lisaInHero =
      hero && lisa &&
      lisa.top >= hero.top &&
      lisa.bottom <= hero.bottom + 1;
    const tableColumns = tableStyle?.gridTemplateColumns
      .split(' ')
      .filter(Boolean).length ?? 0;
    const desktopCardGrid = tableColumns >= 4 && cardStyle?.gridTemplateAreas.includes('action');
    const mobileList = tableColumns === 1 && cardStyle?.gridTemplateAreas.includes('content');

    return {
      mode,
      overflow: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
      mobileOrder,
      desktopAligned,
      lisaInHero,
      lisaMascot:
        Boolean(document.querySelector('.lisa-bot')) &&
        Boolean(document.querySelector('.lisa-face')) &&
        document.querySelectorAll('.lisa-eye').length === 2 &&
        document.querySelectorAll('.lisa-pupil').length === 0 &&
        document.querySelectorAll('.lisa-cheek').length === 2 &&
        Boolean(document.querySelector('.lisa-mouth')),
      tableColumns,
      desktopCardGrid,
      mobileList,
      hoverMotion:
        cardStyle?.transitionProperty.includes('transform') &&
        linkStyle?.transitionProperty.includes('transform'),
      backgroundMotion: animations.some(name => ['backgroundLines', 'networkPacketTravel', 'networkSweep', 'networkRailFlow', 'networkRailPacket'].includes(name)),
      ambientMotion: animations.some(name => name === 'networkPlaneDrift' || name === 'networkNodeFloat' || name === 'networkRoutePulse'),
      networkBackdrop:
        document.querySelectorAll('.network-route').length >= 5 &&
        document.querySelectorAll('.network-node').length >= 6 &&
        document.querySelectorAll('.network-plane').length >= 2,
      visibleNetworkBackdrop:
        Boolean(lineField) &&
        Number(lineFieldStyle?.opacity ?? '0') >= 0.85 &&
        lineFieldStyle?.zIndex !== '-2' &&
        bodyBeforeStyle?.zIndex !== '-3' &&
        document.querySelectorAll('.network-sweep').length >= 2 &&
        document.querySelectorAll('.network-rail').length >= 3,
      lisaMotion: animations.some(name => name.startsWith('lisa')),
      cardHeights,
      textOverflow: [...document.querySelectorAll('h1,h2,p,a,button,input,.badge,.metric span,.lisa-state')]
        .filter(element => element.scrollWidth - element.clientWidth > 3)
        .map(element => element.textContent?.trim().slice(0, 60))
    };
  }, mode);

  if (result.overflow > 2) {
    throw new Error(`${mode} horizontal overflow: ${result.overflow}`);
  }
  if (result.textOverflow.length) {
    throw new Error(`${mode} text overflow: ${result.textOverflow.join(' | ')}`);
  }
  if (!result.backgroundMotion) {
    throw new Error(`${mode} background motion missing`);
  }
  if (!result.networkBackdrop) {
    throw new Error(`${mode} network backdrop elements missing: ${JSON.stringify(result)}`);
  }
  if (!result.visibleNetworkBackdrop) {
    throw new Error(`${mode} visible network backdrop contract failed: ${JSON.stringify(result)}`);
  }
  if (!result.ambientMotion) {
    throw new Error(`${mode} ambient trace motion missing`);
  }
  if (!result.lisaMotion) {
    throw new Error(`${mode} Lisa live motion missing`);
  }
  if (!result.lisaInHero || !result.lisaMascot) {
    throw new Error(`${mode} Lisa mascot contract failed: ${JSON.stringify(result)}`);
  }
  if (!result.hoverMotion) {
    throw new Error(`${mode} hover motion contract failed: ${JSON.stringify(result)}`);
  }
  if (mode === 'desktop' && (!result.desktopAligned || !result.desktopCardGrid)) {
    throw new Error(`desktop layout contract failed: ${JSON.stringify(result)}`);
  }
  if (mode === 'mobile' && (!result.mobileOrder || !result.mobileList)) {
    throw new Error(`mobile layout contract failed: ${JSON.stringify(result)}`);
  }
  if (mode === 'mobile' && Math.max(...result.cardHeights) > 105) {
    throw new Error(`mobile service cards are too tall: ${JSON.stringify(result)}`);
  }

  return result;
}

async function probeLisaExpression(page) {
  await page.evaluate(() => {
    window.__homelabDashboard?.playLisaExpression({ x: '2px', y: '-1px', wink: 'right', smile: true });
  });
  await page.waitForTimeout(160);

  const result = await page.evaluate(() => {
    const panel = document.querySelector('#lisaStatus');
    const bot = panel?.querySelector('.lisa-bot');
    const face = panel?.querySelector('.lisa-face');
    const leftEye = panel?.querySelector('.lisa-eye-left');
    const rightEye = panel?.querySelector('.lisa-eye-right');
    const mouth = panel?.querySelector('.lisa-mouth');
    const pupils = [...panel?.querySelectorAll('.lisa-pupil') ?? []];
    const faceStyle = face ? getComputedStyle(face) : null;
    const botStyle = bot ? getComputedStyle(bot) : null;
    const rightEyeStyle = rightEye ? getComputedStyle(rightEye) : null;
    const leftEyeStyle = leftEye ? getComputedStyle(leftEye) : null;
    const mouthStyle = mouth ? getComputedStyle(mouth) : null;
    const panelAfterStyle = panel ? getComputedStyle(panel, '::after') : null;
    const personalityDelay = window.__homelabDashboard?.lisaPersonalityDelay;
    const botRect = bot?.getBoundingClientRect();
    const faceRect = face?.getBoundingClientRect();
    const rightEyeRect = rightEye?.getBoundingClientRect();
    const leftEyeRect = leftEye?.getBoundingClientRect();
    const mouthRect = mouth?.getBoundingClientRect();

    return {
      debugHook: typeof window.__homelabDashboard?.playLisaExpression === 'function',
      roundedFace: Number.parseFloat(faceStyle?.borderTopLeftRadius ?? '0') >= 16,
      faceCoverage: botRect && faceRect
        ? (faceRect.width * faceRect.height) / (botRect.width * botRect.height)
        : 0,
      pupils: pupils.length,
      personalityCount: window.__homelabDashboard?.lisaPersonalityCount ?? 0,
      personalityLoopMin: personalityDelay?.loopMin ?? 0,
      lookX: botStyle?.getPropertyValue('--look-x').trim(),
      lookY: botStyle?.getPropertyValue('--look-y').trim(),
      smiling: bot?.classList.contains('is-smiling-wide') ?? false,
      winking: bot?.classList.contains('is-wink-right') ?? false,
      leftEyeWidth: Number.parseFloat(leftEyeStyle?.width ?? '0'),
      rightEyeWidth: Number.parseFloat(rightEyeStyle?.width ?? '0'),
      rightEyeHeight: Number.parseFloat(rightEyeStyle?.height ?? '0'),
      leftEyeHeight: Number.parseFloat(leftEyeStyle?.height ?? '0'),
      eyeGap: rightEyeRect && leftEyeRect ? rightEyeRect.left - leftEyeRect.right : 0,
      leftEyeAnimation: leftEyeStyle?.animationName,
      rightEyeAnimation: rightEyeStyle?.animationName,
      mouthWidth: Number.parseFloat(mouthStyle?.width ?? '0'),
      mouthBottomGap: mouthRect && faceRect ? faceRect.bottom - mouthRect.bottom : 0,
      mouthBorderLeft: Number.parseFloat(mouthStyle?.borderLeftWidth ?? '0'),
      mouthBorderRight: Number.parseFloat(mouthStyle?.borderRightWidth ?? '0'),
      mouthBorderBottom: Number.parseFloat(mouthStyle?.borderBottomWidth ?? '0'),
      radarHidden: panelAfterStyle?.display === 'none',
      idleAnimationDuration: botStyle?.animationDuration,
      idleAnimationTiming: botStyle?.animationTimingFunction,
      verticalEyes: Number.parseFloat(leftEyeStyle?.height ?? '0') > Number.parseFloat(leftEyeStyle?.width ?? '0') + 4,
      winkCollapsed: Number.parseFloat(rightEyeStyle?.width ?? '0') > Number.parseFloat(rightEyeStyle?.height ?? '0') + 8,
      faceTransformTransition: faceStyle?.transitionProperty.includes('transform') ?? false,
      mouthBelowEyes: Boolean(
        mouthRect &&
        rightEyeRect &&
        leftEyeRect &&
        mouthRect.top > Math.max(rightEyeRect.bottom, leftEyeRect.bottom) + 2.5
      ),
      mouthInsideFace: Boolean(
        mouthRect &&
        faceRect &&
        mouthRect.bottom <= faceRect.bottom - 3 &&
        mouthRect.left >= faceRect.left + 2 &&
        mouthRect.right <= faceRect.right - 2
      )
    };
  });

  if (
    !result.debugHook ||
    !result.roundedFace ||
    result.faceCoverage < 0.72 ||
    result.pupils !== 0 ||
    result.personalityCount < 8 ||
    result.personalityLoopMin < 5000 ||
    result.lookX === '0px' ||
    result.lookY === '0px' ||
    !result.smiling ||
    !result.winking ||
    result.leftEyeWidth < 12 ||
    result.rightEyeWidth < 15 ||
    result.rightEyeHeight >= result.leftEyeHeight ||
    result.eyeGap <= 0 ||
    result.leftEyeAnimation !== 'none' ||
    result.rightEyeAnimation !== 'none' ||
    result.mouthWidth < 48 ||
    result.mouthBottomGap < 3.5 ||
    result.mouthBorderLeft !== 0 ||
    result.mouthBorderRight !== 0 ||
    result.mouthBorderBottom < 4 ||
    !result.radarHidden ||
    !result.verticalEyes ||
    !result.winkCollapsed ||
    !result.faceTransformTransition ||
    Number.parseFloat(result.idleAnimationDuration) < 9 ||
    result.idleAnimationTiming !== 'linear' ||
    !result.mouthBelowEyes ||
    !result.mouthInsideFace
  ) {
    throw new Error(`Lisa expression probe failed: ${JSON.stringify(result)}`);
  }

  return result;
}

async function probeLisaLaugh(page) {
  await page.evaluate(() => {
    window.__homelabDashboard?.playLisaExpression({ x: '0px', y: '-1px', classes: ['is-laughing'], duration: 1500 });
  });
  await page.waitForTimeout(180);

  const result = await page.evaluate(() => {
    const panel = document.querySelector('#lisaStatus');
    const bot = panel?.querySelector('.lisa-bot');
    const face = panel?.querySelector('.lisa-face');
    const mouth = panel?.querySelector('.lisa-mouth');
    const leftEye = panel?.querySelector('.lisa-eye-left');
    const rightEye = panel?.querySelector('.lisa-eye-right');
    const faceRect = face?.getBoundingClientRect();
    const mouthRect = mouth?.getBoundingClientRect();
    const mouthStyle = mouth ? getComputedStyle(mouth) : null;
    const mouthBeforeStyle = mouth ? getComputedStyle(mouth, '::before') : null;
    const leftEyeStyle = leftEye ? getComputedStyle(leftEye) : null;
    const leftEyeBeforeStyle = leftEye ? getComputedStyle(leftEye, '::before') : null;
    const leftEyeAfterStyle = leftEye ? getComputedStyle(leftEye, '::after') : null;
    const rightEyeStyle = rightEye ? getComputedStyle(rightEye) : null;
    const matrixValue = (transform, index) => {
      const values = transform?.match(/matrix\(([^)]+)\)/)?.[1]?.split(',').map(Number);
      return values?.[index] ?? 0;
    };

    return {
      laughing: bot?.classList.contains('is-laughing') ?? false,
      mouthWidth: Number.parseFloat(mouthStyle?.width ?? '0'),
      mouthHeight: Number.parseFloat(mouthStyle?.height ?? '0'),
      mouthBorderTop: Number.parseFloat(mouthStyle?.borderTopWidth ?? '0'),
      mouthBorderBottom: Number.parseFloat(mouthStyle?.borderBottomWidth ?? '0'),
      mouthDivider: Number.parseFloat(mouthBeforeStyle?.height ?? '0'),
      mouthHasFill:
        mouthStyle?.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
        mouthStyle?.backgroundImage !== 'none',
      chevronEyes:
        leftEyeStyle?.backgroundImage === 'none' &&
        rightEyeStyle?.backgroundImage === 'none' &&
        leftEyeBeforeStyle?.content !== 'none' &&
        leftEyeAfterStyle?.content !== 'none' &&
        Number.parseFloat(leftEyeBeforeStyle?.width ?? '0') >= 7 &&
        Number.parseFloat(leftEyeAfterStyle?.width ?? '0') >= 7 &&
        Number.parseFloat(leftEyeBeforeStyle?.left ?? '0') < 3 &&
        Number.parseFloat(leftEyeAfterStyle?.right ?? '0') < 3 &&
        leftEyeBeforeStyle?.transform !== 'none' &&
        leftEyeAfterStyle?.transform !== 'none',
      chevronPeaksUp:
        matrixValue(leftEyeBeforeStyle?.transform, 1) < 0 &&
        matrixValue(leftEyeAfterStyle?.transform, 1) > 0,
      mouthBottomGap: mouthRect && faceRect ? faceRect.bottom - mouthRect.bottom : 0,
      mouthInsideFace: Boolean(
        mouthRect &&
        faceRect &&
        mouthRect.bottom <= faceRect.bottom - 2.5 &&
        mouthRect.left >= faceRect.left + 2 &&
        mouthRect.right <= faceRect.right - 2
      )
    };
  });

  if (
    !result.laughing ||
    result.mouthWidth < 44 ||
    result.mouthWidth > 50 ||
    result.mouthHeight < 22 ||
    result.mouthBorderTop < 3 ||
    result.mouthBorderBottom < 3 ||
    result.mouthDivider < 2 ||
    !result.mouthHasFill ||
    !result.chevronEyes ||
    !result.chevronPeaksUp ||
    result.mouthBottomGap < 2.5 ||
    !result.mouthInsideFace
  ) {
    throw new Error(`Lisa laugh probe failed: ${JSON.stringify(result)}`);
  }

  return result;
}

async function probeLisaWorking(page) {
  await page.evaluate(() => {
    window.__homelabDashboard?.previewLisaWorking();
  });
  await page.waitForTimeout(220);

  const result = await page.evaluate(() => {
    const panel = document.querySelector('#lisaStatus');
    const face = panel?.querySelector('.lisa-face');
    const pulse = panel?.querySelector('.lisa-work-pulse');
    const state = panel?.querySelector('.lisa-state');
    const mouth = panel?.querySelector('.lisa-mouth');
    const leftEye = panel?.querySelector('.lisa-eye-left');
    const rightEye = panel?.querySelector('.lisa-eye-right');
    const animations = document.getAnimations({ subtree: true })
      .map(animation => animation.animationName)
      .filter(Boolean);
    const pulseStyle = pulse ? getComputedStyle(pulse) : null;
    const faceStyle = face ? getComputedStyle(face) : null;
    const mouthStyle = mouth ? getComputedStyle(mouth) : null;
    const leftEyeStyle = leftEye ? getComputedStyle(leftEye) : null;
    const rightEyeStyle = rightEye ? getComputedStyle(rightEye) : null;

    return {
      workingClass: panel?.classList.contains('is-working') ?? false,
      liveClass: panel?.classList.contains('is-live') ?? false,
      stateText: state?.textContent?.trim(),
      hasPulse: Boolean(pulse),
      pulseHidden: Number(pulseStyle?.opacity ?? '1') === 0,
      pulseAnimationRemoved: !animations.includes('lisaWorkingDots'),
      focusAnimation: animations.includes('lisaWorkingFocus'),
      panelPulse: animations.includes('lisaDeployPanelPulse'),
      faceAnimation: faceStyle?.animationName,
      leftEyeRadius: Number.parseFloat(leftEyeStyle?.borderTopLeftRadius ?? '0'),
      mouthWidth: Number.parseFloat(mouthStyle?.width ?? '0'),
      mouthHeight: Number.parseFloat(mouthStyle?.height ?? '0'),
      leftEyeHeight: Number.parseFloat(leftEyeStyle?.height ?? '0'),
      rightEyeHeight: Number.parseFloat(rightEyeStyle?.height ?? '0')
    };
  });

  if (
    !result.workingClass ||
    !result.liveClass ||
    !result.stateText?.startsWith('Desplegando:') ||
    !result.hasPulse ||
    !result.pulseHidden ||
    !result.pulseAnimationRemoved ||
    !result.focusAnimation ||
    !result.panelPulse ||
    result.leftEyeRadius < 8 ||
    result.mouthWidth > 40 ||
    result.mouthHeight > 14 ||
    result.leftEyeHeight < 18 ||
    result.rightEyeHeight < 18
  ) {
    throw new Error(`Lisa working probe failed: ${JSON.stringify(result)}`);
  }

  return result;
}

async function probeLisaHoverTracking(page) {
  const box = await page.locator('#lisaStatus .lisa-face').boundingBox();
  const panelBox = await page.locator('#lisaStatus').boundingBox();
  if (!box) {
    throw new Error('No Lisa face available for hover tracking probe.');
  }
  if (!panelBox) {
    throw new Error('No Lisa status panel available for hover tracking probe.');
  }

  await page.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.42);
  await page.waitForTimeout(120);
  const leftLook = await readLisaHoverTrackingState(page);

  await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.58);
  await page.waitForTimeout(120);
  const rightLook = await readLisaHoverTrackingState(page);

  await page.mouse.move(Math.max(0, panelBox.x - 24), Math.max(0, panelBox.y - 24));
  await page.waitForTimeout(180);
  const afterLeave = await page.evaluate(() => {
    const panel = document.querySelector('#lisaStatus');
    const bot = panel?.querySelector('.lisa-bot');
    return {
      tracking: panel?.classList.contains('is-pointer-tracking') ?? false,
      lookX: bot?.style.getPropertyValue('--look-x').trim(),
      lookY: bot?.style.getPropertyValue('--look-y').trim()
    };
  });

  const movedHorizontally = leftLook.lookXNumber < -0.4 && rightLook.lookXNumber > 0.4;
  const noHoverWink = !leftLook.winking && !rightLook.winking;
  const animationsPaused =
    leftLook.panelAnimationPaused &&
    leftLook.botAnimationPaused &&
    leftLook.faceAnimationPaused &&
    leftLook.eyeAnimationName === 'none';
  const resetAfterLeave =
    !afterLeave.tracking &&
    (afterLeave.lookX === '0px' || afterLeave.lookX === '') &&
    (afterLeave.lookY === '0px' || afterLeave.lookY === '');

  const result = {
    leftLook,
    rightLook,
    afterLeave,
    movedHorizontally,
    noHoverWink,
    animationsPaused,
    resetAfterLeave
  };

  if (!leftLook.tracking || !rightLook.tracking || !movedHorizontally || !noHoverWink || !animationsPaused || !resetAfterLeave) {
    throw new Error(`Lisa hover tracking probe failed: ${JSON.stringify(result)}`);
  }

  return result;
}

async function probeLisaHistoryLayer(page) {
  const box = await page.locator('#lisaStatus').boundingBox();
  if (!box) {
    throw new Error('No Lisa status panel available for history layer probe.');
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(120);

  const result = await page.evaluate(() => {
    const panel = document.querySelector('#lisaStatus');
    const history = panel?.querySelector('.lisa-history');
    const timeText = history?.querySelector('time')?.textContent?.trim() ?? '';
    const dateText = history?.querySelector('.history-date')?.textContent?.trim() ?? '';
    const clockText = history?.querySelector('.history-clock')?.textContent?.trim() ?? '';
    const rect = history?.getBoundingClientRect();
    const style = history ? getComputedStyle(history) : null;

    if (!history || !rect) {
      return {
        visible: false,
        topElementIsHistory: false
      };
    }

    const x = Math.min(rect.right - 8, Math.max(rect.left + 8, rect.left + rect.width / 2));
    const y = Math.min(rect.bottom - 8, Math.max(rect.top + 8, rect.top + 24));
    const topElement = document.elementFromPoint(x, y);

    return {
      display: style?.display,
      timeText,
      dateText,
      clockText,
      dateTimePattern: /^\d{2}\/\d{2}\s*\d{2}:\d{2}$/.test(timeText) &&
        /^\d{2}\/\d{2}$/.test(dateText) &&
        /^\d{2}:\d{2}$/.test(clockText),
      visible: style?.display !== 'none' && rect.width > 0 && rect.height > 0,
      topElementIsHistory: Boolean(topElement?.closest('.lisa-history')),
      topElementClass: topElement?.className?.toString() ?? '',
      rect: {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right
      }
    };
  });

  if (!result.visible || !result.topElementIsHistory || !result.dateTimePattern) {
    throw new Error(`Lisa history layer probe failed: ${JSON.stringify(result)}`);
  }

  return result;
}

async function readLisaHoverTrackingState(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('#lisaStatus');
    const bot = panel?.querySelector('.lisa-bot');
    const face = panel?.querySelector('.lisa-face');
    const eye = panel?.querySelector('.lisa-eye-left');
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const botStyle = bot ? getComputedStyle(bot) : null;
    const faceStyle = face ? getComputedStyle(face) : null;
    const eyeStyle = eye ? getComputedStyle(eye) : null;
    const lookX = bot?.style.getPropertyValue('--look-x').trim() ?? '0px';
    const lookY = bot?.style.getPropertyValue('--look-y').trim() ?? '0px';

    return {
      tracking: panel?.classList.contains('is-pointer-tracking') ?? false,
      winking:
        bot?.classList.contains('is-wink-left') ||
        bot?.classList.contains('is-wink-right') ||
        false,
      expressiveClasses: [...bot?.classList ?? []].filter(className => className.startsWith('is-')),
      lookX,
      lookY,
      lookXNumber: Number.parseFloat(lookX),
      lookYNumber: Number.parseFloat(lookY),
      panelAnimationPaused: panelStyle?.animationPlayState === 'paused',
      botAnimationPaused: botStyle?.animationPlayState === 'paused',
      faceAnimationPaused: faceStyle?.animationPlayState === 'paused',
      eyeAnimationName: eyeStyle?.animationName
    };
  });
}

async function probeServiceHover(page) {
  const box = await page.locator('.service-card').first().boundingBox();
  if (!box) {
    throw new Error('No service card available for hover probe.');
  }

  await page.mouse.move(box.x + box.width * 0.78, box.y + box.height * 0.28);
  await page.waitForTimeout(120);

  const result = await page.evaluate(() => {
    const card = document.querySelector('.service-card');
    const beam = card?.querySelector('.service-hover-beam');
    const animations = document.getAnimations({ subtree: true })
      .map(animation => animation.animationName)
      .filter(Boolean);

    return {
      tilting: card?.classList.contains('is-tilting') ?? false,
      mx: card?.style.getPropertyValue('--mx').trim(),
      rx: card?.style.getPropertyValue('--rx').trim(),
      ry: card?.style.getPropertyValue('--ry').trim(),
      hasBeam: Boolean(beam),
      beamOpacity: beam ? getComputedStyle(beam).opacity : '0',
      sweepMotion: animations.includes('serviceSpecularSweep') || animations.includes('serviceButtonSweep')
    };
  });

  if (!result.tilting || !result.hasBeam || result.rx === '0deg' || result.ry === '0deg' || Number(result.beamOpacity) <= 0 || !result.sweepMotion) {
    throw new Error(`Service hover probe failed: ${JSON.stringify(result)}`);
  }

  return result;
}

function isLightRgb(color) {
  const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
  if (channels.length < 3) {
    return false;
  }

  const [red, green, blue] = channels.map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.72;
}

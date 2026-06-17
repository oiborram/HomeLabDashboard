const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];

  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('http://127.0.0.1:8443/', {
    waitUntil: 'networkidle',
    timeout: 15000
  });

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
  const api = await page.evaluate(async () =>
    fetch('/_dashboard/api').then(response => response.json()));

  await page.locator('input[type="search"]').fill('Daria');
  const filtered = await page.locator('.service-card').count();

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
  if (!links.some(link => link.href === '/daria/')) {
    throw new Error('Daria link was not rendered.');
  }
  if (filtered < 1) {
    throw new Error('Search did not keep Daria visible.');
  }
  if (errors.length > 0) {
    throw new Error(`Browser console errors: ${errors.join(' | ')}`);
  }

  console.log(JSON.stringify({
    title,
    h1,
    summary,
    cards,
    lisa,
    links,
    apiHosts: api.publicHosts,
    filtered,
    errors
  }, null, 2));

  await browser.close();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});

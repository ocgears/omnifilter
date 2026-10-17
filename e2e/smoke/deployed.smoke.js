// Checks a deployed copy of the hosted demo where it runs (see
// playwright.config.js here, and docs/CLOUD_RUN.md): that it's healthy and
// in cloud mode, that the page reaches the API at its own address, and that
// a visitor can filter the sample photo on their own GPU. With SMOKE_EMAIL
// and SMOKE_PASSWORD it also signs in, as an account kept for this. It
// keeps nothing, so the database stays as it was.
//
// Unlike the other end-to-end tests it doesn't tell the page where the API
// is: finding it from the page's own address is part of what's checked.
const { test, expect } = require('@playwright/test');
const { notice } = require('../helpers');

// Errors the page logged or threw, which a deployed copy shouldn't have.
const errors = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push('uncaught: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
});

test.afterEach(({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  // eslint-disable-next-line no-control-regex
  const failure = (testInfo.error?.message || '').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 1500);
  notice('error', 'Smoke test "' + testInfo.title + '" failed at ' + page.url(),
    failure + (errors.length ? '\nPage errors: ' + errors.slice(0, 5).join('\n') : ''));
});

// An IPv4 address as Express may give it (::ffff:203.0.113.7), plainly.
const plainIp = (ip) => String(ip).replace(/^::ffff:/, '');

test('is healthy, and sees callers at their own addresses', async ({ request }) => {
  // A made-up X-Forwarded-For must not be believed: the per-address limits
  // on sign-ins and transforms would be easy to dodge.
  const res = await request.get('/health', { headers: { 'X-Forwarded-For': '203.0.113.7' } });
  expect(res.status()).toBe(200);
  const health = await res.json();
  expect(health).toMatchObject({ ok: true, database: true });
  const ip = plainIp(health.ip);
  notice('notice', 'The server sees this test at', ip);
  expect(ip).not.toBe('203.0.113.7');
  // The workflow passes the runner's public address, as a website sees it.
  if (process.env.SMOKE_PUBLIC_IP) expect(ip).toBe(process.env.SMOKE_PUBLIC_IP.trim());
});

test('runs in cloud mode, with no filtering device of its own', async ({ request }) => {
  const settings = await (await request.get('/settings')).json();
  expect(settings).toMatchObject({ mode: 'cloud', processing: 'device', guests: 'device', maxStoredPhotos: 5 });
  const device = await request.get('/device');
  expect(device.status()).toBe(200);
  expect(await device.json()).toBeNull();
});

test('serves the page, which calls the API at its own address, and its scripts compressed', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  // Its security headers (server/lib/security_headers.js); the guest test
  // below fails on anything the policy blocks, which the browser logs.
  expect(res.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(res.headers()).not.toHaveProperty('x-powered-by');
  const html = await res.text();
  expect(html).toContain('<meta name="omnifilter-api" content="/">');
  const script = /<script src="([^"]+\.js)"/.exec(html)?.[1];
  expect(script, 'a script in the page').toBeTruthy();
  const js = await request.get('/' + script.replace(/^\//, ''), { headers: { 'Accept-Encoding': 'gzip, br' } });
  expect(js.status()).toBe(200);
  expect(js.headers()['content-encoding']).toMatch(/gzip|br/);
  expect(js.headers()['cache-control']).toContain('immutable');
});

test('a guest filters the sample photo at full size on this device', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.banner.guest')).toBeVisible();
  await expect(page.locator('.device-info')).toContainText("this device's own GPU");
  await page.getByRole('button', { name: 'Try a sample photo' }).click();
  await expect(page.locator('.file-name')).toHaveText('Earth from Apollo 17 (NASA).jpg');
  await page.locator('#filter-0').selectOption({ label: 'Invert' });
  await page.locator('#transform').click();
  const card = page.locator('of-result-card');
  await expect(card.getByRole('status')).toContainText(/^12\.0 MP, made on /, { timeout: 90000 });
  notice('notice', 'The sample photo', await card.getByRole('status').textContent());
  await card.getByRole('button', { name: 'Discard' }).click();
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('signs in to the account kept for this test', async ({ page, request }) => {
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  test.skip(!email || !password, 'SMOKE_EMAIL and SMOKE_PASSWORD are not set');
  // The first run makes the account.
  const basic = 'Basic ' + Buffer.from(email + ':' + password).toString('base64');
  if ((await request.get('/signin', { headers: { Authorization: basic } })).status() === 401) {
    const made = await request.post('/signup', { data: { email: email, password: password, confirmation: password } });
    expect(made.status(), 'making the smoke test account').toBe(200);
  }
  await page.goto('/#/signin');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('header').getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('.device-info')).toContainText("this device's own GPU");
  expect(errors).toEqual([]);
});

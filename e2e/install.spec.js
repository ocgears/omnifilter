// Installing OmniFilter as an app (the web app manifest), and photos shared
// to it from other apps: the phone POSTs them to /share-target, where the
// service worker (client/public/sw.js) keeps the photo for the photo page.
const { test, expect } = require('@playwright/test');
const { setUp, gradientJpeg } = require('./helpers');

setUp();

test('is installable: a manifest with icons and a share target', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const res = await request.get(href);
  expect(res.ok()).toBe(true);
  expect(res.headers()['content-type']).toMatch(/application\/manifest\+json/);
  const manifest = await res.json();
  expect(manifest).toMatchObject({ name: 'OmniFilter', display: 'standalone', start_url: '/#/home' });
  expect(manifest.share_target).toMatchObject({ action: '/share-target', method: 'POST' });
  const sizes = manifest.icons.map((i) => i.sizes + ' ' + i.purpose);
  expect(sizes).toEqual(expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']));
  for (const icon of manifest.icons) {
    const png = await request.get(icon.src);
    expect(png.ok(), icon.src).toBe(true);
    expect(png.headers()['content-type']).toBe('image/png');
  }
});

test('opens a photo shared from another app', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Share targets are a Chromium (Android) feature.');
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  // What the phone does when OmniFilter is picked in a share sheet: a form
  // POST to the manifest's share_target, with the photo as "photo".
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/share-target';
    form.enctype = 'multipart/form-data';
    form.innerHTML = '<input type="file" name="photo" id="shared">';
    document.body.append(form);
  });
  await page.locator('#shared').setInputFiles({
    name: 'from-gallery.jpg',
    mimeType: 'image/jpeg',
    buffer: await gradientJpeg(120, 80)
  });
  await page.evaluate(() => document.querySelector('form[action="/share-target"]').submit());
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('#preview')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  // Used once: it doesn't come back on the next visit.
  expect(await page.evaluate(() => caches.has('omnifilter-shared'))).toBe(false);
});

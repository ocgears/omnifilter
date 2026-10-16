// The hosted demo's mode (OMNIFILTER_MODE=cloud), against a second server
// started that way (playwright.config.js): photos are filtered at full size
// on the browser's own GPU (in a Web Worker), offered to save or share, and
// kept only when asked, up to 5 for each account. Browsers without WebGPU
// (the iphone project's WebKit) are told what they need instead.
const { test, expect } = require('@playwright/test');
const { setUp, choosePhoto, photos, hasWebGpu } = require('./helpers');

const CLOUD_PORT = Number(process.env.E2E_CLOUD_PORT) || 3931;
test.use({ baseURL: 'http://localhost:' + CLOUD_PORT });
setUp();

const run = Date.now();
const email = () => 'cloud-' + run + '-' + test.info().project.name + '@example.com';
const password = 'correct horse battery';

const card = (page) => page.locator('of-result-card');

// The red, green and blue of a pixel of the result card's image, and its
// natural size, read back from the image itself.
const resultPixel = (page, x, y) => card(page).locator('img').evaluate(async (img, [px, py]) => {
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const g = canvas.getContext('2d');
  g.drawImage(img, 0, 0);
  const [r, gr, b] = g.getImageData(px, py, 1, 1).data;
  return { size: img.naturalWidth + 'x' + img.naturalHeight, rgb: [r, gr, b] };
}, [x, y]);

test('filters a guest\'s photo at full size on this device, and keeps it when asked', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.banner.guest')).toBeVisible();
  await choosePhoto(page, 2400, 1600);
  await page.locator('#filter-0').selectOption({ label: 'Invert' });

  if (!(await hasWebGpu(page))) {
    await expect(page.locator('.device-info')).toContainText('needs a browser with WebGPU');
    await page.locator('#transform').click();
    await expect(page.getByRole('alert')).toContainText('needs a browser with WebGPU');
    await expect(card(page)).toHaveCount(0);
    return;
  }
  await expect(page.locator('.device-info')).toContainText("this device's own GPU");
  await page.locator('#transform').click();
  // Decoding, filtering and encoding 3.8 MP take long enough to see this.
  await expect(page.locator('of-live-preview .status')).toContainText('paused');
  await expect(card(page)).toBeVisible({ timeout: 60000 });
  await expect(card(page).getByRole('status')).toContainText(/^3\.8 MP, made on .+ in [\d.]+ s \([\d.]+ MP\/s\)$/);
  await expect(card(page)).toContainText(/decode [\d.]+ s · to the GPU .* · encode [\d.]+ s/);
  // The live preview carries on after the job.
  await expect(page.locator('of-live-preview .status')).toContainText('Live preview');
  await expect(page.locator('of-live-preview .status')).not.toContainText('paused');

  // Full size, and inverted: the gradient's dark left edge is light now.
  const { size, rgb } = await resultPixel(page, 2, 800);
  expect(size).toBe('2400x1600');
  expect(rgb[0]).toBeGreaterThan(200);
  await expect(card(page).getByRole('link', { name: 'Save' })).toHaveAttribute('download', /^omnifilter-invert-.+\.jpg$/);

  // Nothing is kept until asked; then it's kept in this browser.
  await expect(photos(page)).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Keep in this browser (1 of 5)' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(photos(page)).toHaveCount(1);
  await expect(page.locator('#gallery-title')).toContainText('1 of 5 kept');
  await page.reload();
  await expect(photos(page)).toHaveCount(1);
});

test('tries the sample photo, Earth from Apollo 17, at full size: 12 megapixels', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sample-credit')).toContainText('Photo: NASA');
  await page.getByRole('button', { name: 'Try a sample photo' }).click();
  await expect(page.locator('.file-name')).toHaveText('Earth from Apollo 17 (NASA).jpg');
  await expect(page.locator('.sample-credit')).toHaveCount(0);
  test.skip(!(await hasWebGpu(page)), 'this browser has no WebGPU');
  await page.locator('#filter-0').selectOption({ label: 'Invert' });
  await page.locator('#transform').click();
  await expect(card(page).getByRole('status')).toContainText(/^12\.0 MP, made on /, { timeout: 120000 });
  // Inverted: the black of space in the corner is white now.
  const { size, rgb } = await resultPixel(page, 4, 4);
  expect(size).toBe('3464x3464');
  expect(rgb[0]).toBeGreaterThan(240);
  await card(page).getByRole('button', { name: 'Discard' }).click();
});

test('runs the filters scaled down when the GPU\'s buffers are too small, then enlarges them', async ({ page }) => {
  // Pretend the largest buffer is 4 MB: a million pixels.
  await page.addInitScript(() => {
    window.OMNIFILTER_DEVICE_MAX_BYTES = 4e6;
  });
  await page.goto('/');
  await choosePhoto(page, 2400, 1600);
  test.skip(!(await hasWebGpu(page)), 'this browser has no WebGPU');
  await page.locator('#filter-0').selectOption({ label: 'Invert' });
  await page.locator('#transform').click();
  await expect(card(page)).toContainText(/Filtered at \d+×\d+ to fit this GPU, then enlarged to 2400×1600/,
    { timeout: 60000 });
  const { size, rgb } = await resultPixel(page, 2, 800);
  expect(size).toBe('2400x1600');
  expect(rgb[0]).toBeGreaterThan(200);
  await card(page).getByRole('button', { name: 'Discard' }).click();
  await expect(card(page)).toHaveCount(0);
});

test('keeps at most 5 photos for an account', async ({ page }) => {
  await page.goto('/#/signup');
  await expect(page.getByRole('heading', { level: 1, name: 'Create an account' })).toBeVisible();
  await page.locator('#email').fill(email());
  await page.locator('#password').fill(password);
  await page.locator('#confirmation').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/#\/home$/);

  // Five photos kept already (as the page keeps them: POST /import).
  const statuses = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 6;
    canvas.getContext('2d').fillRect(0, 0, 8, 6);
    const content = canvas.toDataURL('image/jpeg');
    const out = [];
    for (let n = 0; n < 6; n++) {
      const res = await fetch('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: localStorage.getItem('token') },
        body: JSON.stringify({ content: content, tOption: 'invert' })
      });
      out.push(res.status);
    }
    return out;
  });
  expect(statuses).toEqual([200, 200, 200, 200, 200, 409]);
  await page.reload();
  await expect(photos(page)).toHaveCount(5);
  await expect(page.locator('#gallery-title')).toContainText('5 of 5 kept');

  await choosePhoto(page);
  await page.locator('#filter-0').selectOption({ label: 'Invert' });
  test.skip(!(await hasWebGpu(page)), 'this browser has no WebGPU');
  await page.locator('#transform').click();
  await expect(card(page).getByRole('button', { name: 'Gallery full (5 of 5)' })).toBeDisabled({ timeout: 60000 });

  // With one deleted there's room again.
  const first = photos(page).first();
  await first.getByRole('button', { name: 'Delete' }).click();
  await first.getByRole('button', { name: 'Delete' }).click();
  await expect(photos(page)).toHaveCount(4);
  await card(page).getByRole('button', { name: 'Keep in gallery (5 of 5)' }).click();
  await expect(photos(page)).toHaveCount(5);
  await page.reload();
  await expect(photos(page)).toHaveCount(5);
});

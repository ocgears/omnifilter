// The main paths through the app in a real browser: signing up and in,
// filtering a photo on the OpenCL device, a preset stack, the saved photos
// surviving a reload, deleting, and signing out.
const { test, expect } = require('@playwright/test');
const sharp = require('sharp');

const email = 'e2e-' + Date.now() + '@example.com';
const password = 'correct horse battery';

// The page calls the API on port 3000 of its own host unless told otherwise;
// here the API server serves the page itself.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.OMNIFILTER_API = '';
  });
});

// A small left-to-right gradient, opaque, so the filters' effect is easy to see.
async function gradientJpeg(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      pixels[i] = Math.round(255 * x / (width - 1));
      pixels[i + 1] = Math.round(255 * y / (height - 1));
      pixels[i + 2] = 96;
    }
  }
  return sharp(pixels, { raw: { width: width, height: height, channels: 3 } }).jpeg().toBuffer();
}

async function signIn(page) {
  await page.goto('/#/signin');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.locator('header')).toContainText('Hello ' + email);
}

// Picks the test image and waits for the preview.
async function choosePhoto(page) {
  await page.locator('#file').setInputFiles({
    name: 'gradient.jpg',
    mimeType: 'image/jpeg',
    buffer: await gradientJpeg(96, 64)
  });
  await page.getByRole('button', { name: 'Upload for Preview' }).click();
  await expect(page.locator('#preview')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
}

const photos = (page) => page.locator('li.single-photo');

test.describe.configure({ mode: 'serial' });

test('the start page asks to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('OmniFilter');
  await expect(page).toHaveURL(/#\/signin$/);
  await expect(page.locator('footer')).toContainText('MIT license');
});

test('signs up and lands on the photo page', async ({ page }) => {
  await page.goto('/#/signup');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.locator('input[name=confirmation]').fill(password);
  await page.getByRole('button', { name: 'Create New User' }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('header')).toContainText('Hello ' + email);
  await expect(page.locator('.device-info')).toContainText('Filters run on');
});

test('refuses a second account with the same email', async ({ page }) => {
  await page.goto('/#/signup');
  await page.locator('input[name=email]').fill(email.toUpperCase());
  await page.locator('input[name=password]').fill(password);
  await page.locator('input[name=confirmation]').fill(password);
  await page.getByRole('button', { name: 'Create New User' }).click();
  await expect(page.locator('.errors-section')).toContainText('already exists');
});

test('refuses a wrong password', async ({ page }) => {
  await page.goto('/#/signin');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill('not the password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.locator('.errors-section')).toBeVisible();
  await expect(page.locator('header')).not.toContainText('Hello');
});

test('filters a photo on the device and shows the result', async ({ page }) => {
  await signIn(page);
  await expect(photos(page)).toHaveCount(0);
  await choosePhoto(page);
  await page.locator('#filter-0').selectOption({ label: 'Invert' });
  await page.locator('#transform').click();

  await expect(photos(page)).toHaveCount(1);
  const result = photos(page).first();
  await expect(result).toContainText('Invert');
  const src = await result.locator('img').getAttribute('src');
  expect(src).toMatch(/^data:image\/jpeg;base64,/);

  // The left edge of the gradient is dark, so inverted it's light.
  const image = sharp(Buffer.from(src.split(',')[1], 'base64'));
  const { data } = await image.extract({ left: 0, top: 0, width: 4, height: 4 }).raw()
    .toBuffer({ resolveWithObject: true });
  expect(data[0]).toBeGreaterThan(200);
});

test('applies a preset stack', async ({ page }) => {
  await signIn(page);
  await choosePhoto(page);
  await page.locator('#preset').selectOption({ label: 'Toy camera' });
  await expect(page.locator('li.layer')).toHaveCount(3);
  await page.locator('#transform').click();
  await expect(photos(page)).toHaveCount(2);
  await expect(page.locator('.errors-section')).toHaveCount(0);
});

test('keeps the saved photos after a reload, and deletes one', async ({ page }) => {
  await signIn(page);
  await page.reload();
  await expect(photos(page)).toHaveCount(2);

  await photos(page).filter({ hasText: 'Invert' }).getByRole('button', { name: 'Delete Photo' }).click();
  await expect(photos(page)).toHaveCount(1);
  await expect(page.locator('.server-msg')).toBeVisible();

  await page.reload();
  await expect(photos(page)).toHaveCount(1);
});

test('signs out', async ({ page }) => {
  await signIn(page);
  await page.locator('header').getByText('logout').click();
  await expect(page.locator('header')).not.toContainText('Hello');
  await page.reload();
  await expect(page.locator('header')).not.toContainText('Hello');
});

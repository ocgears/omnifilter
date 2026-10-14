// The main paths through the app in a real browser, at desktop and phone
// sizes (see the projects in playwright.config.js): trying it as a guest,
// signing up and in, filtering a photo on the OpenCL device, a preset stack,
// undo and the work in progress surviving a reload, the saved photos
// surviving a reload, deleting, and signing out.
const { test, expect } = require('@playwright/test');
const sharp = require('sharp');

// Each project (desktop, phone) gets its own account.
const run = Date.now();
const email = () => 'e2e-' + run + '-' + test.info().project.name + '@example.com';
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
  await page.locator('#email').fill(email());
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('header').getByRole('button', { name: 'Sign out' })).toBeVisible();
}

// Picking a file shows it straight away.
async function choosePhoto(page) {
  await page.locator('#file').setInputFiles({
    name: 'gradient.jpg',
    mimeType: 'image/jpeg',
    buffer: await gradientJpeg(96, 64)
  });
  await expect(page.locator('#preview')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
}

const photos = (page) => page.locator('.photo-card');

// Nothing sticks out sideways, so the page never scrolls horizontally.
async function expectNoSidewaysScroll(page) {
  const [scrollWidth, width] = await page.evaluate(() =>
    [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

test.describe.configure({ mode: 'serial' });

// When a test fails, say where the page was and what it showed, as an
// annotation on the GitHub Actions run (the full logs need sign-in).
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const state = await page.evaluate(() => ({
    url: location.href,
    headings: Array.from(document.querySelectorAll('h1, h2')).map((h) => h.textContent.trim()),
    alerts: Array.from(document.querySelectorAll('[role=alert], [role=status]'))
      .map((a) => a.textContent.trim()).filter(Boolean),
    disabled: Array.from(document.querySelectorAll('button:disabled')).map((b) => b.textContent.trim())
  })).catch((e) => ({ error: e.message }));
  const where = testInfo.project.name + ' / ' + testInfo.title;
  const message = JSON.stringify(state).replace(/%/g, '%25').replace(/\r?\n/g, '%0A');
  console.log(process.env.GITHUB_ACTIONS ? '::warning title=Page when "' + where + '" failed::' + message :
    'Page when "' + where + '" failed: ' + message);
});

test('the start page opens the editor, as a guest', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/OmniFilter/);
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('.banner.guest')).toContainText('trying OmniFilter as a guest');
  await expect(page.locator('header').getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('footer')).toContainText('MIT license');
  await expectNoSidewaysScroll(page);
  await page.locator('header').getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('signs up and lands on the photo page', async ({ page }) => {
  await page.goto('/#/signup');
  await page.locator('#email').fill(email());
  await page.locator('#password').fill(password);
  await page.locator('#confirmation').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('header').getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('.device-info')).toContainText('Filters run on');
  await expectNoSidewaysScroll(page);
});

test('refuses a second account with the same email', async ({ page }) => {
  await page.goto('/#/signup');
  await page.locator('#email').fill(email().toUpperCase());
  await page.locator('#password').fill(password);
  await page.locator('#confirmation').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
});

test('refuses a wrong password', async ({ page }) => {
  await page.goto('/#/signin');
  await page.locator('#email').fill(email());
  await page.locator('#password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/#\/signin$/);
  await expect(page.locator('header').getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});

test('makes photos as a guest, then adds them to a new account', async ({ page }) => {
  await page.goto('/');
  await choosePhoto(page);
  await page.locator('#filter-0').selectOption({ label: 'Invert' });
  await page.locator('#transform').click();
  await expect(photos(page)).toHaveCount(1);
  await expect(photos(page).first()).toContainText('Invert');
  await expectNoSidewaysScroll(page);

  // Kept in this browser, across a reload.
  await page.reload();
  await expect(photos(page)).toHaveCount(1);

  await page.locator('.banner.guest').getByRole('link', { name: 'create an account' }).click();
  await page.locator('#email').fill('guest-' + email());
  await page.locator('#password').fill(password);
  await page.locator('#confirmation').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/#\/home$/);

  const banner = page.locator('.banner.waiting');
  await expect(banner).toContainText('1 photo you made before signing in');
  await expect(photos(page)).toHaveCount(0);
  await banner.getByRole('button', { name: 'Add to my account' }).click();
  await expect(banner).toHaveCount(0);
  await expect(photos(page)).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'Added 1 photo' })).toBeVisible();

  // Now it's on the server.
  await page.reload();
  await expect(photos(page)).toHaveCount(1);
  await expect(photos(page).first()).toContainText('Invert');
  await expect(page.locator('.banner')).toHaveCount(0);
});

test('filters a photo on the device and shows the result', async ({ page }) => {
  await signIn(page);
  await expect(photos(page)).toHaveCount(0);
  await choosePhoto(page);
  await page.locator('#filter-0').selectOption({ label: 'Invert' });

  // The Transform button stays on screen, even on a phone.
  await expect(page.locator('#transform')).toBeInViewport();
  await expectNoSidewaysScroll(page);
  await page.locator('#transform').click();

  await expect(photos(page)).toHaveCount(1);
  const result = photos(page).first();
  await expect(result).toContainText('Invert');
  const src = await result.locator('img').getAttribute('src');
  expect(src).toMatch(/^data:image\/jpeg;base64,/);
  await expect(result.getByRole('link', { name: 'Save' })).toHaveAttribute('download', /\.jpg$/);

  // The left edge of the gradient is dark, so inverted it's light.
  const image = sharp(Buffer.from(src.split(',')[1], 'base64'));
  const { data } = await image.extract({ left: 0, top: 0, width: 4, height: 4 }).raw()
    .toBuffer({ resolveWithObject: true });
  expect(data[0]).toBeGreaterThan(200);
});

// The red channel at the left edge of an element's screenshot, halfway down.
async function leftEdgeRed(locator) {
  const png = await locator.screenshot();
  const image = sharp(png);
  const { height } = await image.metadata();
  const { data } = await image.extract({ left: 2, top: Math.floor(height / 2), width: 2, height: 2 })
    .raw().toBuffer({ resolveWithObject: true });
  return data[0];
}

test('previews filters live on this device\'s GPU, and compares with the original', async ({ page }) => {
  await signIn(page);
  await choosePhoto(page);
  const status = page.locator('of-live-preview .status');
  await page.waitForFunction(() => window.omnifilterGpu);
  if (!(await page.evaluate(() => window.omnifilterGpu.available()))) {
    await expect(status).toContainText('needs a browser with WebGPU');
    return;
  }
  await expect(status).toContainText(/Live preview.* ms/);
  // A thumbnail of each preset look on the photo, and of the photo itself.
  const presets = await page.locator('.chips .chip').count();
  await expect(page.locator('canvas.thumb')).toHaveCount(presets);

  // The left edge of the gradient is dark; inverted live, it's light.
  const canvas = page.locator('of-live-preview canvas');
  await page.locator('#filter-0').selectOption({ label: 'Invert' });
  await expect.poll(() => leftEdgeRed(canvas)).toBeGreaterThan(200);

  // Holding the compare button shows the original.
  const compare = page.getByRole('button', { name: 'Hold to compare' });
  const box = await compare.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => leftEdgeRed(canvas)).toBeLessThan(60);
  await page.mouse.up();
  await expect.poll(() => leftEdgeRed(canvas)).toBeGreaterThan(200);

  // If the GPU device is lost (a driver reset, a phone reclaiming memory),
  // the next change gets a new one.
  await page.evaluate(() => window.omnifilterGpu.loseDevice());
  await page.locator('#filter-0').selectOption({ label: 'Threshold' });
  await expect(status).toContainText(/Live preview.* ms/);
  await expect.poll(() => leftEdgeRed(canvas)).toBeLessThan(60);
});

test('filters the live camera, and takes a photo with it', async ({ page }) => {
  await signIn(page);
  await page.waitForFunction(() => window.omnifilterGpu);
  const gpu = await page.evaluate(() => window.omnifilterGpu.available());
  await page.getByRole('button', { name: /Live camera/ }).click();
  const camera = page.locator('of-live-camera');
  if (!gpu) {
    await expect(camera).toContainText('need a browser with WebGPU');
    await camera.getByRole('button', { name: 'Close' }).click();
    return;
  }
  await page.getByRole('button', { name: 'Neon night' }).click();
  await expect(camera.locator('.status')).toContainText(/Live · \d+ ms a frame/);
  await camera.getByRole('button', { name: 'Take photo' }).click();
  await expect(camera).toHaveCount(0);
  await expect(page.locator('.file-name')).toHaveText('Camera photo');
  await expect(page.locator('#preview')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect(page.locator('of-live-preview .status')).toContainText(/Live preview.* ms/);
});

test('applies a preset stack', async ({ page }) => {
  await signIn(page);
  await choosePhoto(page);
  await page.getByRole('button', { name: 'Toy camera' }).click();
  await expect(page.locator('li.layer')).toHaveCount(3);
  await expectNoSidewaysScroll(page);
  await page.locator('#transform').click();
  await expect(photos(page)).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

// The stack's history as saved in the browser ({ labels, index }), or null.
const savedSteps = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('omnifilter');
  req.onerror = () => resolve(null);
  req.onsuccess = () => {
    const get = req.result.transaction('draft').objectStore('draft').get('stack');
    get.onsuccess = () => resolve(get.result ?
      { labels: get.result.steps.map((s) => s.label), index: get.result.index } : null);
    get.onerror = () => resolve(null);
  };
}));

test('undoes edits, and keeps the work in progress after a reload', async ({ page }) => {
  await signIn(page);
  await choosePhoto(page);
  await page.locator('#filter-0').selectOption({ label: 'Invert' });
  await page.getByRole('button', { name: '+ Stack another filter' }).click();
  await page.locator('#filter-1').selectOption({ label: 'Greyscale' });
  await expect(page.locator('li.layer')).toHaveCount(2);

  await page.locator('#undo').click();
  await expect(page.locator('#filter-1')).toHaveValue('');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('li.layer')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('li.layer')).toHaveCount(2);

  // The list of edits, to go back to any of them.
  await page.locator('details.history summary').click();
  const steps = page.locator('.steps button');
  await expect(steps).toHaveText(
    ['Start', 'Layer 1: Invert', 'Added a layer', 'Layer 2: Greyscale']);
  await expect(steps.nth(2)).toHaveAttribute('aria-current', 'step');
  await steps.nth(1).click();
  await expect(page.locator('li.layer')).toHaveCount(1);
  await expect(page.locator('.steps')).toBeHidden();
  await expectNoSidewaysScroll(page);

  // A reload (which phones do to tabs in the background) loses nothing.
  await expect.poll(async () => (await savedSteps(page) || {}).index).toBe(1);
  await page.reload();
  await expect(page.locator('#preview')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect(page.locator('.file-name')).toHaveText('gradient.jpg');
  await expect(page.locator('li.layer')).toHaveCount(1);
  await expect(page.locator('#filter-0 option:checked')).toHaveText('Invert');
  await page.locator('#redo').click();
  await expect(page.locator('li.layer')).toHaveCount(2);
});

test("uses a saved photo's settings again", async ({ page }) => {
  await signIn(page);
  const card = photos(page).filter({ hasText: 'Tilt-shift' });
  await card.getByRole('button', { name: 'Use settings' }).click();
  await expect(page.locator('li.layer')).toHaveCount(3);
  await expect(page.locator('#filter-0 option:checked')).toHaveText('Tilt-shift');
  await page.locator('#undo').click();
  await expect(page.locator('li.layer')).toHaveCount(1);
});

test('keeps the saved photos after a reload, and deletes one', async ({ page }) => {
  await signIn(page);
  await page.reload();
  await expect(photos(page)).toHaveCount(2);

  const card = photos(page).filter({ hasText: 'Invert' });
  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(card).toContainText('Delete this photo?');
  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(photos(page)).toHaveCount(1);
  await expect(page.getByRole('status')).toContainText('deleted');

  await page.reload();
  await expect(photos(page)).toHaveCount(1);
});

test('signs out', async ({ page }) => {
  await signIn(page);
  await page.locator('header').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/#\/signin$/);
  // The work in progress goes too, for whoever uses this browser next.
  await expect.poll(() => savedSteps(page)).toBeNull();
  await page.reload();
  await expect(page.locator('header').getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  // The photo page is the guest's now: none of the account's photos.
  await page.goto('/#/home');
  await expect(page.locator('.banner.guest')).toBeVisible();
  await expect(photos(page)).toHaveCount(0);
});

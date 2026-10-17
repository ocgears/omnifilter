// The main paths through the app in a real browser, at desktop and phone
// sizes (see the projects in playwright.config.js): trying it as a guest,
// signing up and in, filtering a photo on the OpenCL device, a preset stack,
// undo and the work in progress surviving a reload, the saved photos
// surviving a reload, deleting, and signing out.
const { test, expect } = require('@playwright/test');
const sharp = require('sharp');
const { setUp, choosePhoto, photos, expectNoSidewaysScroll, leftEdgeRed, hasWebGpu } = require('./helpers');

setUp();

// Each project (desktop, phone, iphone) gets its own account.
const run = Date.now();
const email = () => 'e2e-' + run + '-' + test.info().project.name + '@example.com';
const password = 'correct horse battery';

// Fills in the sign-in or sign-up form. It waits for the page's heading
// first: the heading's text and the form's fields are filled in by the same
// Angular update, and typing into a field before then is lost when Angular
// writes the (empty) form into it. A busy browser (CI's software GPU still
// finishing the previous page's work) can leave that gap open long enough.
async function fillAuthForm(page, fields) {
  const heading = fields.confirmation === undefined ? 'Sign in' : 'Create an account';
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await page.locator('#email').fill(fields.email);
  await page.locator('#password').fill(fields.password);
  if (fields.confirmation !== undefined) await page.locator('#confirmation').fill(fields.confirmation);
}

async function signIn(page) {
  await page.goto('/#/signin');
  await fillAuthForm(page, { email: email(), password: password });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('header').getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

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
  await fillAuthForm(page, { email: email(), password: password, confirmation: password });
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('header').getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('.device-info')).toContainText('Filters run on');
  await expectNoSidewaysScroll(page);
});

test('refuses a second account with the same email', async ({ page }) => {
  await page.goto('/#/signup');
  await fillAuthForm(page, { email: email().toUpperCase(), password: password, confirmation: password });
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
});

test('refuses a wrong password', async ({ page }) => {
  await page.goto('/#/signin');
  await fillAuthForm(page, { email: email(), password: 'not the password' });
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
  await fillAuthForm(page, { email: 'guest-' + email(), password: password, confirmation: password });
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

test('previews filters live on this device\'s GPU, and compares with the original', async ({ page }) => {
  await signIn(page);
  await choosePhoto(page);
  const status = page.locator('of-live-preview .status');
  if (!(await hasWebGpu(page))) {
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
  // the preview gets a new one straight away, and carries on.
  await page.evaluate(() => window.omnifilterGpu.loseDevice());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => leftEdgeRed(canvas)).toBeLessThan(60);
  await page.mouse.up();
  await expect.poll(() => leftEdgeRed(canvas)).toBeGreaterThan(200);
  await page.locator('#filter-0').selectOption({ label: 'Threshold' });
  await expect(status).toContainText(/Live preview.* ms/);
  await expect.poll(() => leftEdgeRed(canvas)).toBeLessThan(60);
});

test('filters the live camera, and takes a photo with it', async ({ page }) => {
  await signIn(page);
  const gpu = await hasWebGpu(page);
  // Without a camera (as in WebKit's Linux build), there's no camera button.
  if (!(await page.evaluate(() => !!navigator.mediaDevices?.getUserMedia))) {
    await expect(page.getByRole('button', { name: /Live camera/ })).toHaveCount(0);
    return;
  }
  await page.getByRole('button', { name: /Live camera/ }).click();
  const camera = page.locator('of-live-camera');
  if (!gpu) {
    await expect(camera).toContainText('need a browser with WebGPU');
    await camera.getByRole('button', { name: 'Close' }).click();
    return;
  }
  await page.getByRole('button', { name: 'Neon night' }).click();
  await expect(camera.locator('.status')).toContainText(/Live · \d+ ms a frame/);
  // A lost GPU device: the camera carries on with a new one. (Chrome's fake
  // camera is a moving pattern, so frames still coming means it changes.)
  await page.evaluate(() => window.omnifilterGpu.loseDevice());
  const cameraCanvas = camera.locator('canvas');
  const first = await cameraCanvas.screenshot();
  await expect.poll(async () => Buffer.compare(first, await cameraCanvas.screenshot()) !== 0,
    { timeout: 10000 }).toBe(true);
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

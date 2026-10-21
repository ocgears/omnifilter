// The main paths through the app in a real browser, at desktop and phone
// sizes (see the projects in playwright.config.js): trying it as a guest,
// signing up and in, filtering a photo on the OpenCL device, a preset stack,
// undo and the work in progress surviving a reload, the saved photos
// surviving a reload, deleting, and signing out.
const { test, expect } = require('@playwright/test');
const sharp = require('sharp');
const { setUp, choosePhoto, photos, expectNoSidewaysScroll, leftEdgeRed, hasGpu, gradientJpeg } =
  require('./helpers');

setUp();

// Each project (desktop, phone, iphone, firefox, safari) gets its own account.
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

// With the keyboard alone: the first Tab reaches Skip to content, and controls
// that take themselves away (or are disabled while they work) hand the focus
// on, rather than dropping it back to the top of the page.
test('works with the keyboard, keeping the focus in place', async ({ page }) => {
  const press = async (locator, key = 'Enter') => {
    await locator.focus();
    await page.keyboard.press(key);
  };
  const layer = (i) => page.locator('.layers > li').nth(i);
  await page.goto('/#/home');
  await expect(page.locator('#sample')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();

  await press(page.locator('#sample'));
  await expect(page.locator('figure.preview')).toBeFocused();
  await press(page.locator('figcaption').getByRole('button', { name: 'Remove' }));
  await expect(page.locator('#file')).toBeFocused();
  await choosePhoto(page);

  await page.locator('#filter-0').selectOption('sepia');
  await press(page.getByRole('button', { name: '+ Stack another filter' }));
  await page.locator('#filter-1').selectOption('invert');
  // The focus goes with the layer, to its other button now that it's first.
  await press(layer(1).getByRole('button', { name: 'Move filter up' }));
  await expect(page.locator('#filter-0')).toHaveValue('invert');
  await expect(layer(0).getByRole('button', { name: 'Move filter down' })).toBeFocused();
  await press(layer(0).getByRole('button', { name: 'Remove filter' }));
  await expect(page.locator('#filter-0')).toHaveValue('sepia');
  await expect(page.locator('#filter-0')).toBeFocused();
  await press(page.locator('details.history summary'));
  await press(page.locator('details.history').getByRole('button').nth(1));
  await expect(page.locator('details.history')).not.toHaveAttribute('open');
  await expect(page.locator('details.history summary')).toBeFocused();

  // Transform keeps the focus while it works, and says when it's done.
  await page.locator('#filter-0').selectOption('sepia');
  await press(page.locator('#transform'));
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await expect(page.locator('#transform')).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'It is first in your photos.' })).toHaveCount(1);

  // Delete asks first, with the focus on Keep.
  const card = page.locator('.photo-card').first();
  await press(card.getByRole('button', { name: 'Delete' }));
  await expect(card.getByRole('button', { name: 'Keep' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: 'Keep' })).toBeFocused();
  await press(card.locator('button.danger'));
  await expect(page.locator('.photo-card')).toHaveCount(0);
  await expect(page.locator('#transform')).toBeFocused();
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
  await expect(banner).toContainText('1 photo made in this browser without signing in');
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

test('moves a photo kept in this browser by an older version to a file', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.banner.guest')).toBeVisible();
  // As older versions kept them: the photo as a data URL.
  const content = 'data:image/jpeg;base64,' + (await gradientJpeg(1200, 900)).toString('base64');
  await page.evaluate((url) => new Promise((resolve, reject) => {
    const req = indexedDB.open('omnifilter');
    req.onsuccess = () => {
      const tx = req.result.transaction('photos', 'readwrite');
      tx.objectStore('photos').put({ _id: 'local-legacy', content: url, tOption: 'invert',
        createdAt: '2026-10-01T00:00:00.000Z' }, 'local-legacy');
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), content);
  await page.reload();
  await expect(photos(page)).toHaveCount(1);
  await expect(photos(page).first().locator('img')).toHaveAttribute('src', /^data:image\/(webp|jpeg);base64,/);
  const stored = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('omnifilter');
    req.onsuccess = () => {
      const get = req.result.transaction('photos').objectStore('photos').get('local-legacy');
      // A Blob, or where the browser won't store one (Safari's private
      // windows, Playwright's WebKit), the bytes and their type.
      get.onsuccess = () => resolve({
        file: get.result.file instanceof Blob || get.result.fileBytes instanceof ArrayBuffer,
        content: 'content' in get.result && get.result.content !== undefined,
        type: get.result.file ? get.result.file.type : get.result.fileType
      });
    };
  }));
  expect(stored).toEqual({ file: true, content: false, type: 'image/jpeg' });
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
  // The gallery shows a thumbnail; Save fetches the photo itself.
  const src = await result.locator('img').getAttribute('src');
  expect(src).toMatch(/^data:image\/webp;base64,/);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    result.getByRole('button', { name: 'Save' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/^omnifilter-invert-\w{6}\.jpg$/);

  // The left edge of the gradient is dark, so inverted it's light.
  const image = sharp(await download.path());
  const { data } = await image.extract({ left: 0, top: 0, width: 4, height: 4 }).raw()
    .toBuffer({ resolveWithObject: true });
  expect(data[0]).toBeGreaterThan(200);
});

// Each with WebGPU where the browser has it, and with WebGL2, as browsers
// without WebGPU do it.
for (const webgl2 of [false, true]) {
  const backend = webgl2 ? ' (WebGL2)' : '';
  const useWebgl2 = (page) => webgl2 && page.addInitScript(() => {
    window.OMNIFILTER_FORCE_WEBGL2 = true;
  });

  test('previews filters live on this device\'s GPU, and compares with the original' + backend, async ({ page }) => {
    await useWebgl2(page);
    await signIn(page);
    await choosePhoto(page);
    const status = page.locator('of-live-preview .status');
    if (!(await hasGpu(page))) {
      await expect(status).toContainText('needs a browser with WebGPU');
      return;
    }
    await expect(status).toContainText(/Live preview.* ms/);
    if (webgl2) await expect(status).toContainText('WebGL2');
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

  test('filters the live camera, and takes a photo with it' + backend, async ({ page }) => {
    await useWebgl2(page);
    await signIn(page);
    const gpu = await hasGpu(page);
    // Without a camera (as in WebKit's Linux build), there's no camera button.
    if (!(await page.evaluate(() => !!navigator.mediaDevices?.getUserMedia))) {
      await expect(page.getByRole('button', { name: /Live camera/ })).toHaveCount(0);
      return;
    }
    // WebKit's Linux build offers getUserMedia but has no camera to open.
    const opens = await page.evaluate(() => Promise.race([
      navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        return true;
      }, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000))
    ]));
    test.skip(gpu && !opens, 'this browser has no camera to open');
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
}

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

test('shares a kept photo by link, and stops sharing it', async ({ page, browser }) => {
  await signIn(page);
  const card = photos(page).first();
  const label = (await card.locator('.label').textContent()).trim();
  await card.getByRole('button', { name: 'Get link' }).click();
  const link = card.locator('.link-url');
  await expect(link).toHaveAttribute('href', /\/p\/[A-Za-z0-9_-]{22}$/);
  await expect(card.getByRole('button', { name: 'Copy link' })).toBeFocused();
  const url = await link.getAttribute('href');

  // Anyone with the link sees the photo, without signing in.
  const visitor = await browser.newPage();
  await visitor.goto(url);
  await expect(visitor).toHaveTitle(label + ' · OmniFilter');
  await expect(visitor.locator('figcaption')).toContainText(label + ', made with OmniFilter');
  await expect.poll(() => visitor.locator('img').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

  // Still shared after a reload; then not at all.
  await page.reload();
  await expect(photos(page).first().locator('.link-url')).toHaveAttribute('href', url);
  await photos(page).first().getByRole('button', { name: 'Stop sharing' }).click();
  await expect(photos(page).first().getByRole('button', { name: 'Get link' })).toBeFocused();
  const gone = await visitor.goto(url);
  expect(gone.status()).toBe(404);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveText('This photo isn\'t shared');
  await visitor.close();
});

test('keeps the saved photos after a reload, and deletes one', async ({ page }) => {
  await signIn(page);
  await page.reload();
  await expect(photos(page)).toHaveCount(2);
  // Each picture fills its card's 4:3 frame, whatever the photo's own size.
  const box = await photos(page).first().locator('img').boundingBox();
  expect(Math.abs(box.height - box.width * 3 / 4)).toBeLessThan(2);

  const card = photos(page).filter({ hasText: 'Invert' });
  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(card).toContainText('Delete this photo?');
  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(photos(page)).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'deleted' })).toHaveCount(1);

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

test('signs out of all devices', async ({ page, browser, baseURL }) => {
  await signIn(page);
  // Another device, signed in to the same account.
  const other = await browser.newContext({ baseURL: baseURL });
  // The API is the page's own server, as setUp() tells the test's own page.
  await other.addInitScript(() => {
    window.OMNIFILTER_API = '';
  });
  const otherPage = await other.newPage();
  await signIn(otherPage);
  const otherToken = await otherPage.evaluate(() => localStorage.getItem('token'));

  await page.locator('footer').getByRole('button', { name: 'Sign out of all devices' }).click();
  await expect(page.locator('footer')).toContainText('this one too?');
  await page.locator('footer').getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page).toHaveURL(/#\/signin$/);
  // The other device's sign-in is over too.
  expect((await page.request.get('/getAll', { headers: { token: otherToken } })).status()).toBe(401);
  await other.close();
});

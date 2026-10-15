// The app on touch screens (the phone and iphone projects in
// playwright.config.js): used by touch rather than a mouse, at the common
// phone widths upright and sideways, through axe's accessibility checks, and
// on a slowed-down phone. All of it as a guest, which needs no account.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const {
  setUp, notice, choosePhoto, photos, expectNoSidewaysScroll, leftEdgeRed, hasWebGpu
} = require('./helpers');

setUp();

// Each test has a new browser profile, so it starts as a new guest.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.banner.guest')).toBeVisible();
});

// Real touches, through Chromium's DevTools protocol, which delivers them as
// the phone's screen would (Playwright's own touchscreen can only tap).
// WebKit has no equivalent, so there these gestures are skipped.
async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type: type, touchPoints: type === 'touchEnd' ? [] : [{ x: x, y: y }]
  });
  const centre = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2, box];
  };
  return {
    // Puts a finger down on an element and keeps it there until up().
    async press(locator) {
      const [x, y] = await centre(locator);
      await touch('touchStart', x, y);
    },
    up: () => touch('touchEnd'),
    // Drags a finger from one point to another, in small steps.
    async drag([x1, y1], [x2, y2]) {
      await touch('touchStart', x1, y1);
      for (let i = 1; i <= 12; i++) {
        await touch('touchMove', x1 + (x2 - x1) * i / 12, y1 + (y2 - y1) * i / 12);
      }
      await touch('touchEnd');
    },
    // A quick swipe across an element, as for scrolling it.
    async swipe(locator, dx, dy) {
      const [x, y] = await centre(locator);
      await cdp.send('Input.synthesizeScrollGesture', {
        x: x, y: y, xDistance: dx, yDistance: dy, gestureSourceType: 'touch', speed: 1200
      });
    },
    centre: centre
  };
}

test('is used by touch: looks, filters, sliders, history and Transform', async ({ page, browserName }) => {
  await choosePhoto(page);
  const chromium = browserName === 'chromium';
  const finger = chromium ? await fingers(page) : null;

  // The row of looks scrolls sideways under a finger.
  const looks = page.locator('.chips');
  if (chromium && await looks.evaluate((el) => el.scrollWidth > el.clientWidth)) {
    await finger.swipe(looks, -250, 0);
    await expect.poll(() => looks.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  }
  await page.getByRole('button', { name: 'Toy camera' }).tap();
  await expect(page.locator('li.layer')).toHaveCount(3);
  await page.locator('#undo').tap();
  await expect(page.locator('li.layer')).toHaveCount(1);

  await page.locator('#filter-0').selectOption({ label: 'Gaussian blur' });
  const slider = page.locator('li.layer').first().locator('input[type=range]').first();
  const output = page.locator('li.layer').first().locator('output').first();
  const before = await output.textContent();
  if (chromium) {
    // Dragging the slider's handle all the way right sets its highest value,
    // and makes one step in the history, however far the finger moved.
    const [, y, box] = await finger.centre(slider);
    const value = Number(await slider.inputValue());
    const min = Number(await slider.getAttribute('min'));
    const max = Number(await slider.getAttribute('max'));
    const handle = box.x + 8 + (box.width - 16) * (value - min) / (max - min);
    await finger.drag([handle, y], [box.x + box.width + 40, y]);
    await expect(output).toHaveText(String(max));
  } else {
    await slider.focus();
    await page.keyboard.press('End');
    await expect(output).toHaveText(await slider.getAttribute('max'));
  }

  // The list of edits opens as a sheet that fits on the screen.
  await page.locator('details.history summary').tap();
  const steps = page.locator('.steps');
  await expect(steps).toBeVisible();
  await expect(steps).toBeInViewport({ ratio: 1 });
  await expect(steps.locator('button')).toHaveText(['Start', 'Layer 1: Gaussian blur', /Radius/]);
  await steps.locator('button').nth(1).tap();
  await expect(steps).toBeHidden();
  await expect(output).toHaveText(before);

  // Transform stays on screen and works by tap.
  await expect(page.locator('#transform')).toBeInViewport();
  await page.locator('#transform').tap();
  await expect(photos(page)).toHaveCount(1);
  await expect(photos(page).first()).toContainText('Gaussian blur');
  await expectNoSidewaysScroll(page);
});

test('compares with the original while a finger is held on the photo', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'needs real touch events (Chromium only)');
  await choosePhoto(page);
  test.skip(!(await hasWebGpu(page)), 'this browser has no WebGPU, so no live preview');
  const canvas = page.locator('of-live-preview canvas');
  await page.locator('#filter-0').selectOption({ label: 'Invert' });
  await expect.poll(() => leftEdgeRed(canvas)).toBeGreaterThan(200);

  // The long press mustn't bring up the phone's own menu for the image.
  await page.evaluate(() => {
    window.contextMenus = [];
    addEventListener('contextmenu', (e) => window.contextMenus.push(e.defaultPrevented));
  });
  const finger = await fingers(page);
  await finger.press(canvas);
  await page.waitForTimeout(800);
  await expect.poll(() => leftEdgeRed(canvas)).toBeLessThan(60);
  await finger.up();
  await expect.poll(() => leftEdgeRed(canvas)).toBeGreaterThan(200);
  expect(await page.evaluate(() => window.contextMenus.filter((prevented) => !prevented))).toEqual([]);
});

test('keeps each control clear of the sticky photo and Transform bar when it has focus', async ({ page }) => {
  await choosePhoto(page);
  await page.getByRole('button', { name: 'Toy camera' }).tap();
  await expect(page.locator('li.layer')).toHaveCount(3);
  await page.locator('details.mix summary').first().tap();
  // The looks get their thumbnails a moment later, which moves everything
  // below them down.
  if (await hasWebGpu(page)) {
    await expect(page.locator('canvas.thumb')).toHaveCount(await page.locator('.chips .chip').count());
  }

  // Focus each control in turn, as the keyboard (or a screen reader) would;
  // the browser scrolls it into view, and nothing may cover its middle.
  const { checked, covered } = await page.evaluate(async () => {
    const out = [];
    let count = 0;
    const controls = document.querySelectorAll(
      '.controls :is(button, select, input, summary):not([disabled]):not(.visually-hidden)');
    for (const el of controls) {
      if (!el.checkVisibility() || el.closest('.action-bar')) continue;
      el.focus();
      count++;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) {
        out.push((el.id || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30)) +
          ' at y=' + Math.round(r.y) + ', under ' + (hit ? hit.tagName + '.' + hit.className : 'nothing'));
      }
    }
    return { checked: count, covered: out };
  });
  expect(checked).toBeGreaterThan(20);
  expect(covered).toEqual([]);
});

// Phone sizes in CSS pixels, upright; each is also tried sideways.
const SIZES = [
  [320, 568], // iPhone SE (1st generation), the narrowest still in use
  [360, 740], // many Android phones
  [375, 667], // iPhone SE (2nd and 3rd generations)
  [390, 844], // iPhone 12 to 14
  [412, 915] // Pixel 7
];

// Buttons, links and fields smaller than a fingertip (44 by 44 px). Links in
// a sentence are left out, as WCAG allows.
const smallTargets = (page) => page.evaluate(() => {
  const out = [];
  const els = document.querySelectorAll(
    'button, a[href], select, summary, label.button, input:not([type=file]):not(.visually-hidden)');
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest('p')) continue;
    if (r.width < 43.5 || r.height < 43.5) {
      out.push((el.id || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30)) + ' ' +
        Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }
  return out;
});

test('fits every common phone width, upright and sideways', async ({ page }) => {
  // The page's viewport lets people zoom in.
  const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
  expect(viewport).toContain('width=device-width');
  expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0*)?\b/);

  const check = async (where) => {
    const size = page.viewportSize();
    const at = where + ' at ' + size.width + 'x' + size.height;
    const [scrollWidth] = await page.evaluate(() => [document.documentElement.scrollWidth]);
    expect(scrollWidth, at + ': page width').toBeLessThanOrEqual(size.width);
    expect(await smallTargets(page), at + ': small targets').toEqual([]);
  };

  const sizes = SIZES.flatMap(([w, h]) => [[w, h], [h, w]]);
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width: width, height: height });
    await check('empty photo page');
  }

  await choosePhoto(page);
  await page.getByRole('button', { name: 'Toy camera' }).tap();
  await expect(page.locator('li.layer')).toHaveCount(3);
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width: width, height: height });
    await check('photo page');
    await expect(page.locator('#transform'), 'Transform at ' + width + 'x' + height).toBeInViewport();
  }

  await page.goto('/#/signup');
  await expect(page.getByRole('heading', { level: 1, name: 'Create an account' })).toBeVisible();
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width: width, height: height });
    await check('sign-up page');
  }
});

// axe-core's checks for WCAG 2.2 A and AA, on each page and state.
async function expectAccessible(page, where) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const problems = results.violations.map((v) => v.id + ' (' + v.impact + '): ' + v.help + ' — ' +
    v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', '));
  expect(problems, where).toEqual([]);
}

test('passes the accessibility checks', async ({ page }) => {
  await expectAccessible(page, 'empty photo page');
  await choosePhoto(page);
  await page.getByRole('button', { name: 'Toy camera' }).tap();
  await expect(page.locator('li.layer')).toHaveCount(3);
  await page.locator('details.mix summary').first().tap();
  await expectAccessible(page, 'photo page with a preset');
  await page.locator('details.history summary').tap();
  await expectAccessible(page, 'history open');
  await page.locator('details.history summary').tap();
  await page.locator('#transform').tap();
  await expect(photos(page)).toHaveCount(1);
  await expectAccessible(page, 'with a result');
  for (const route of ['signin', 'signup']) {
    await page.goto('/#/' + route);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, route + ' page');
  }
});

// A mid-range phone on a poor connection: the processor 4 times slower and
// "slow 4G" (Lighthouse's settings: 150 ms, 1.6 Mbit/s down, 750 kbit/s up).
// The times go on the run's summary page; the limits only catch big slowdowns.
test('stays usable on a slow phone and connection', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'slowing the browser down needs Chromium');
  test.setTimeout(180000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8
  });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const times = {};
  let start = Date.now();
  await page.reload();
  await expect(page.locator('.dropzone')).toBeVisible();
  times.open = Date.now() - start;

  // A 3 MP photo, as a phone's camera might be set to save.
  start = Date.now();
  await choosePhoto(page, 2000, 1500);
  times.photo = Date.now() - start;

  start = Date.now();
  await page.getByRole('button', { name: 'Toy camera' }).tap();
  await expect(page.locator('li.layer')).toHaveCount(3);
  if (await hasWebGpu(page)) {
    await expect(page.locator('of-live-preview .status')).toContainText(/Live preview.* ms/);
    times.preview = Date.now() - start;
    times.previewSays = await page.locator('of-live-preview .status').textContent();
  }

  // Up to the server, filtered, and back: a guest's photo isn't kept there.
  start = Date.now();
  await page.locator('#transform').tap();
  await expect(photos(page)).toHaveCount(1, { timeout: 120000 });
  times.transform = Date.now() - start;

  notice('notice', 'Slow phone (' + test.info().project.name + ')', Object.entries(times)
    .map(([k, v]) => k + ': ' + (typeof v === 'number' ? (v / 1000).toFixed(1) + ' s' : v.trim())).join(', '));
  expect(times.open, 'time to open the page').toBeLessThan(30000);
  expect(times.photo, 'time to show a photo').toBeLessThan(10000);
  expect(times.transform, 'time to transform').toBeLessThan(90000);
});

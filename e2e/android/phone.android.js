// A smoke test of the app in Chrome on Android, in the emulator the nightly
// mobile-devices workflow starts (.github/android-emulator.sh), driven by
// Playwright's Android support. All as a guest.
//
// Clicks go through Chrome's DevTools connection, not the screen: taps sent
// to the emulator's screen (adb's `input tap`, or Playwright's
// device.input.tap) never reached the page, so Android's own touch handling
// isn't tested here. Real touch is tested in e2e/mobile.spec.js instead,
// through Chromium's touch events. See docs/MOBILE_TESTING.md.
//   npx playwright test -c e2e/android
const { test: base, expect, _android } = require('@playwright/test');
const { notice, choosePhoto, photos } = require('../helpers');

const URL = 'http://localhost:' + (Number(process.env.E2E_PORT) || 3930) + '/';

const test = base.extend({
  // Playwright needs the fixtures argument written as a pattern, even empty.
  // eslint-disable-next-line no-empty-pattern
  device: [async ({}, use) => {
    const [device] = await _android.devices();
    if (!device) throw new Error('No Android device: is the emulator running (adb devices)?');
    await use(device);
    await device.close();
  }, { scope: 'worker' }],

  // A new Chrome session for each test. The emulator reaches the server as
  // localhost through `adb reverse` (see the workflow), so the page is a
  // secure context, as WebGPU and the camera need.
  phone: async ({ device }, use, testInfo) => {
    await device.shell('am force-stop com.android.chrome');
    await device.shell('pm clear com.android.chrome');
    const context = await device.launchBrowser();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(URL);
    await expect(page.locator('.banner.guest')).toBeVisible();
    await use(page);
    await device.screenshot({ path: testInfo.outputPath('screen.png') });
    await context.close();
  }
});

test('opens as a guest, and says what this Chrome can do', async ({ phone }) => {
  const about = await phone.evaluate(async () => ({
    userAgent: navigator.userAgent,
    screen: innerWidth + 'x' + innerHeight + ' at ' + devicePixelRatio + 'x',
    webgpu: !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)),
    camera: !!navigator.mediaDevices?.getUserMedia
  }));
  notice('notice', 'Android Chrome', JSON.stringify(about));
  await expect(phone.locator('footer')).toContainText('MIT license');
  const [scrollWidth, width] = await phone.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  expect(scrollWidth).toBeLessThanOrEqual(width);
});

// Not a check yet (see docs/MOBILE_TESTING.md): whether taps on the
// emulator's screen reach the page at all, by two of adb's ways in. The
// middle of the screen is the page's whatever its toolbars, so where exactly
// the tap lands doesn't matter here. Reported, not judged.
test('taps on the screen reach the page (experiment)', async ({ phone, device }) => {
  await phone.evaluate(() => {
    window.taps = [];
    for (const type of ['touchstart', 'pointerdown', 'click']) {
      document.addEventListener(type, () => window.taps.push(type), true);
    }
  });
  const size = /(\d+)x(\d+)/.exec((await device.shell('wm size')).toString());
  const x = Math.round(Number(size[1]) / 2);
  const y = Math.round(Number(size[2]) / 2);
  const results = [];
  for (const command of ['input tap ' + x + ' ' + y, 'input touchscreen swipe ' + x + ' ' + y + ' ' + x + ' ' + y + ' 80']) {
    await phone.evaluate(() => { window.taps.length = 0; });
    await device.shell(command);
    await phone.waitForTimeout(1000);
    results.push(command.split(' ').slice(0, 2).join(' ') + ': ' +
      ((await phone.evaluate(() => window.taps.join(','))) || 'nothing'));
  }
  notice('notice', 'Android taps (experiment)', results.join('; '));
});

test('makes a photo, and keeps the work after a reload', async ({ phone }) => {
  await choosePhoto(phone);
  await phone.getByRole('button', { name: 'Toy camera' }).click();
  await expect(phone.locator('li.layer')).toHaveCount(3);
  await phone.locator('#undo').click();
  await expect(phone.locator('li.layer')).toHaveCount(1);
  await phone.locator('#redo').click();
  await expect(phone.locator('li.layer')).toHaveCount(3);

  await phone.locator('#transform').click();
  await expect(photos(phone)).toHaveCount(1, { timeout: 60000 });
  // The card lists the look's filters.
  await expect(photos(phone).first()).toContainText('Tilt-shift');

  // Android may drop a tab in the background and reload it later.
  await phone.reload();
  await expect(phone.locator('li.layer')).toHaveCount(3);
  await expect(photos(phone)).toHaveCount(1);
});

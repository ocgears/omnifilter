// The app in Chrome on Android, in the emulator the CI's android job starts
// (.github/android-emulator.sh), driven through adb by Playwright's Android
// support. Taps and presses are real ones, sent to the screen with
// `adb shell input`, so Android's own handling of them (its menu for a held
// image, scrolling, the toolbar hiding) happens as on a phone. All as a guest.
//   npx playwright test -c e2e/android
const { test: base, expect, _android } = require('@playwright/test');
const { notice, choosePhoto, photos, leftEdgeRed } = require('../helpers');

const URL = 'http://localhost:' + (Number(process.env.E2E_PORT) || 3930) + '/';

const test = base.extend({
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

// Where on the screen (in the device's pixels) an element's middle is. The
// page's position on the screen changes as Chrome's toolbar shows and hides,
// so it's measured each time: a clear layer over the page notes where a tap
// at the screen's middle lands.
async function screenPoint(device, page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const size = String(await device.shell('wm size')).match(/(\d+)x(\d+)\s*$/);
  const [width, height] = [Number(size[1]), Number(size[2])];
  await page.evaluate(() => {
    const layer = document.createElement('div');
    layer.id = 'touch-calibration';
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
    layer.addEventListener('pointerdown', (e) => {
      window.calibration = [e.clientX, e.clientY];
      layer.remove();
    });
    window.calibration = null;
    document.body.append(layer);
  });
  await device.shell('input tap ' + Math.round(width / 2) + ' ' + Math.round(height / 2));
  const [cx, cy] = await (await page.waitForFunction(() => window.calibration)).jsonValue();
  const dpr = await page.evaluate(() => devicePixelRatio);
  const box = await locator.boundingBox();
  return [
    Math.round(width / 2 + (box.x + box.width / 2 - cx) * dpr),
    Math.round(height / 2 + (box.y + box.height / 2 - cy) * dpr)
  ];
}

async function tap(device, page, locator) {
  const [x, y] = await screenPoint(device, page, locator);
  await device.shell('input tap ' + x + ' ' + y);
}

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

test('makes a photo by touch, and keeps the work after a reload', async ({ device, phone }) => {
  await choosePhoto(phone);
  await tap(device, phone, phone.getByRole('button', { name: 'Toy camera' }));
  await expect(phone.locator('li.layer')).toHaveCount(3);
  await tap(device, phone, phone.locator('#undo'));
  await expect(phone.locator('li.layer')).toHaveCount(1);
  await tap(device, phone, phone.locator('#redo'));
  await expect(phone.locator('li.layer')).toHaveCount(3);

  await tap(device, phone, phone.locator('#transform'));
  await expect(photos(phone)).toHaveCount(1, { timeout: 60000 });
  await expect(photos(phone).first()).toContainText('Toy camera');

  // Android may drop a tab in the background and reload it later.
  await phone.reload();
  await expect(phone.locator('li.layer')).toHaveCount(3);
  await expect(photos(phone)).toHaveCount(1);
});

test("holding a finger on the photo compares, without Android's image menu", async ({ device, phone }) => {
  await choosePhoto(phone);
  await phone.waitForFunction(() => window.omnifilterGpu);
  const live = await phone.evaluate(() => window.omnifilterGpu.available());
  test.skip(!live, "this Chrome has no WebGPU, so there's no live preview to compare with");

  const canvas = phone.locator('of-live-preview canvas');
  await phone.locator('#filter-0').selectOption({ label: 'Invert' });
  await expect.poll(() => leftEdgeRed(canvas)).toBeGreaterThan(200);
  const [x, y] = await screenPoint(device, phone, canvas);
  // A 2.5 s press; part way through, the original should be showing.
  const press = device.shell('input swipe ' + x + ' ' + y + ' ' + x + ' ' + y + ' 2500');
  await phone.waitForTimeout(1200);
  const held = await leftEdgeRed(canvas);
  await press;
  const menu = await device.wait({ textContains: 'Download image' }, { timeout: 1500 }).then(() => true, () => false);
  if (menu) await device.shell('input keyevent KEYCODE_BACK');
  expect(menu, "Android's menu for the image").toBe(false);
  expect(held, 'red at the left edge while held (the original is dark there)').toBeLessThan(60);
  await expect.poll(() => leftEdgeRed(canvas)).toBeGreaterThan(200);
});

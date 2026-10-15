// What the end-to-end test files share: the page set-up, the failure
// reports, test photos, and checks used at every screen size.
const { test, expect } = require('@playwright/test');
const sharp = require('sharp');

// Registers the hooks every test file wants. Call it at the top of the file.
function setUp() {
  // The page calls the API on port 3000 of its own host unless told
  // otherwise; here the API server serves the page itself.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.OMNIFILTER_API = '';
    });
  });

  // Errors the page logged or threw during each test, for the report below.
  const pageErrors = new WeakMap();
  test.beforeEach(async ({ page }) => {
    const errors = [];
    pageErrors.set(page, errors);
    page.on('pageerror', (e) => errors.push('uncaught: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('console: ' + m.text());
    });
  });

  // When a test fails, say where the page was and what it showed, as an
  // annotation on the GitHub Actions run (the full logs need sign-in).
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    const state = await page.evaluate(() => ({
      url: location.href,
      size: innerWidth + 'x' + innerHeight,
      headings: Array.from(document.querySelectorAll('h1, h2')).map((h) => h.textContent.trim()),
      alerts: Array.from(document.querySelectorAll('[role=alert], [role=status]'))
        .map((a) => a.textContent.trim()).filter(Boolean),
      disabled: Array.from(document.querySelectorAll('button:disabled')).map((b) => b.textContent.trim()),
      // Lengths, not values: these may be passwords.
      inputs: Array.from(document.querySelectorAll('input:not([type=file])'))
        .map((i) => (i.id || i.name || i.type) + ':' + i.value.length),
      fieldErrors: Array.from(document.querySelectorAll('.field-error')).map((e) => e.textContent.trim())
    })).catch((e) => ({ error: e.message }));
    state.errors = (pageErrors.get(page) || []).slice(0, 8).map((e) => e.slice(0, 300));
    const where = testInfo.project.name + ' / ' + testInfo.title;
    notice('warning', 'Page when "' + where + '" failed', JSON.stringify(state));
  });
}

// A line on the GitHub Actions run's summary page (kind: notice, warning or
// error), or in the log when run elsewhere.
function notice(kind, title, message) {
  if (!process.env.GITHUB_ACTIONS) return console.log(title + ': ' + message);
  console.log('::' + kind + ' title=' + title.replace(/[,:]/g, ' ') + '::' +
    message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A'));
}

// A left-to-right gradient, opaque, so the filters' effect is easy to see.
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

// Picking a file shows it straight away.
async function choosePhoto(page, width = 96, height = 64) {
  await page.locator('#file').setInputFiles({
    name: 'gradient.jpg',
    mimeType: 'image/jpeg',
    buffer: await gradientJpeg(width, height)
  });
  await expect(page.locator('#preview')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
}

const photos = (page) => page.locator('.photo-card');

// Nothing sticks out sideways, so the page never scrolls horizontally.
async function expectNoSidewaysScroll(page) {
  const [scrollWidth, width] = await page.evaluate(() =>
    [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollWidth, 'page width at ' + width + ' px').toBeLessThanOrEqual(width);
}

// The red channel at the left edge of an element's screenshot, halfway down.
async function leftEdgeRed(locator) {
  const png = await locator.screenshot();
  const image = sharp(png);
  const { height } = await image.metadata();
  const { data } = await image.extract({ left: 2, top: Math.floor(height / 2), width: 2, height: 2 })
    .raw().toBuffer({ resolveWithObject: true });
  return data[0];
}

// Whether the browser has WebGPU for the live preview (the built app says).
async function hasWebGpu(page) {
  await page.waitForFunction(() => window.omnifilterGpu);
  return page.evaluate(() => window.omnifilterGpu.available());
}

module.exports = {
  setUp, notice, gradientJpeg, choosePhoto, photos, expectNoSidewaysScroll, leftEdgeRed, hasWebGpu
};

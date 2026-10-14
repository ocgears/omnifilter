// The browser's WebGPU filters against the server's OpenCL ones: every
// filter the browser can preview (with each of its choices) and every
// preset stack, run on the same image both ways, compared pixel by pixel.
// The server side runs right here in the test process; the browser side
// through window.omnifilterGpu in the built app (client/src/gpu/index.ts).
const { test, expect } = require('@playwright/test');
const gpuFilters = require('../server/lib/gpu_filters');
const stack = require('../server/lib/stack');

const W = 61;
const H = 47;

// A gradient with some texture, a transparent hole and a soft alpha edge.
function testImage() {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = Math.floor(x * 255 / (W - 1));
      rgba[i + 1] = Math.floor(y * 255 / (H - 1));
      rgba[i + 2] = Math.floor((Math.sin(x * 0.4) * Math.cos(y * 0.3) + 1) * 127);
      const d = Math.hypot(x - W * 0.8, y - H * 0.2);
      rgba[i + 3] = Math.floor(Math.min(1, Math.max(0, (d - 6) / 4)) * 255);
    }
  }
  return rgba;
}

// How far apart two results are: the largest difference in any channel, the
// share of channel values more than 2 apart, and the mean difference.
function compare(a, b) {
  let max = 0;
  let over = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    if (d > 2) over++;
    sum += d;
  }
  return { max: max, over: over / a.length, mean: sum / a.length };
}

// GPUs round floats slightly differently, so a value can come out a level
// or two apart, and now and then a pixel near a decision (which quadrant,
// which side of a threshold) goes the other way: allow 0.1% of values to be
// further out. Kuwahara and oil paint pick the least varied of several
// regions, so near ties go either way more often; reaction-diffusion runs
// thousands of steps of a chaotic simulation, so tiny float differences grow
// into slightly different patterns.
const LOOSE = {
  kuwahara: { over: 0.002, mean: 0.05 },
  oil_paint: { over: 0.002, mean: 0.05 },
  reaction_diffusion: { over: 0.15, mean: 3 }
};

function expectClose(a, b, name, label) {
  const d = compare(a, b);
  const limits = LOOSE[name] || { over: 0.001, mean: 0.05 };
  const what = label + ': ' + JSON.stringify(d);
  expect(d.over, what).toBeLessThanOrEqual(limits.over);
  expect(d.mean, what).toBeLessThanOrEqual(limits.mean);
}

let page;
let available = false;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/#/signin');
  await page.waitForFunction(() => window.omnifilterGpu);
  available = await page.evaluate(() => window.omnifilterGpu.available());
  const adapter = await page.evaluate(async () => {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    return a ? [a.info.vendor, a.info.architecture, a.info.isFallbackAdapter ? '(software)' : ''].join(' ') : 'none';
  });
  // Shows in the GitHub Actions summary which GPU, if any, the browser had.
  if (process.env.GITHUB_ACTIONS) console.log('::notice title=WebGPU in the e2e browser::' + adapter);
  if (!available && process.env.E2E_REQUIRE_WEBGPU) {
    throw new Error('This browser has no WebGPU, and E2E_REQUIRE_WEBGPU is set');
  }
});

test.afterAll(async () => {
  await page.close();
});

test('compiles every WebGPU kernel', async () => {
  test.skip(!available, 'This browser has no WebGPU');
  expect(await page.evaluate(() => window.omnifilterGpu.compileAll())).toEqual([]);
});

test('runs every previewable filter like the server does', async () => {
  test.skip(!available, 'This browser has no WebGPU');
  test.setTimeout(300000);
  const rgba = testImage();
  const previewable = await page.evaluate(() =>
    window.omnifilterGpu.filters().filter((n) => window.omnifilterGpu.previewable(n)));
  expect(previewable.length).toBeGreaterThan(45);
  for (const f of gpuFilters.list()) {
    if (!previewable.includes(f.name) || f.available === false) continue;
    const variants = [{}];
    for (const p of f.params) {
      if (p.type === 'select') for (const o of p.options.slice(1)) variants.push({ [p.name]: o.value });
    }
    for (const params of variants) {
      const server = await gpuFilters.apply(f.name, Buffer.from(rgba), W, H, params);
      const browser = await page.evaluate(
        ({ name, params, rgba, W, H }) => window.omnifilterGpu.runFilter(name, rgba, W, H, params),
        { name: f.name, params: params, rgba: Array.from(rgba), W: W, H: H });
      expectClose(server, browser, f.name, f.name + ' ' + JSON.stringify(params));
    }
  }
});

test('runs every preset and blend mode like the server does', async () => {
  test.skip(!available, 'This browser has no WebGPU');
  test.setTimeout(300000);
  const rgba = testImage();
  const stacks = stack.presets().map((p) => ({ name: p.name, stack: p.stack }))
    .concat(stack.BLEND_MODES.map((mode) => ({
      name: 'blend ' + mode,
      stack: [{ tOption: 'invert' }, { tOption: 'sepia', blend: mode, amount: 60 }]
    })));
  for (const s of stacks) {
    const layers = stack.normalizeStack(s.stack);
    const server = await stack.applyStack(layers, Buffer.from(rgba), W, H);
    const browser = await page.evaluate(
      ({ layers, modes, rgba, W, H }) => window.omnifilterGpu.runStack(layers, modes, rgba, W, H),
      {
        layers: layers.map((l) => ({ tOption: l.tOption, params: l.tParams, amount: l.amount, blend: l.blend })),
        modes: stack.BLEND_MODES,
        rgba: Array.from(rgba),
        W: W,
        H: H
      });
    expectClose(server, browser, null, s.name);
  }
});

// The WebGPU backend (OMNIFILTER_BACKEND=webgpu, server/lib/webgpu) against
// the OpenCL one: every filter with each of its choices, every preset and
// blend mode, and a filter big enough to run in bands, on the same image
// both ways, compared pixel by pixel. OpenCL runs here; WebGPU in a child
// process (fixtures/webgpu_child.js), as a process uses one backend.
//
// Needs the webgpu package (`npm install webgpu`); skipped without it unless
// OMNIFILTER_REQUIRE_WEBGPU is set, as it is in CI.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const expect = require('chai').expect;
const gpuFilters = require(__dirname + '/../lib/gpu_filters');
const stack = require(__dirname + '/../lib/stack');

var hasDawn = true;
try {
  require.resolve('webgpu');
} catch (e) {
  hasDawn = false;
}

// A gradient with some texture, a transparent hole and a soft alpha edge.
function testImage(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = Math.floor(x * 255 / (width - 1));
      rgba[i + 1] = Math.floor(y * 255 / (height - 1));
      rgba[i + 2] = Math.floor((Math.sin(x * 0.4) * Math.cos(y * 0.3) + 1) * 127);
      const d = Math.hypot(x - width * 0.8, y - height * 0.2);
      rgba[i + 3] = Math.floor(Math.min(1, Math.max(0, (d - 6) / 4)) * 255);
    }
  }
  return rgba;
}

// The share of channel values more than 2 apart, and the mean difference.
function compare(a, b) {
  var over = 0;
  var sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 2) over++;
    sum += d;
  }
  return { over: over / a.length, mean: sum / a.length };
}

// As in e2e/gpu.spec.js: GPUs round floats slightly differently, and
// near-ties (Kuwahara's regions) or thousands of chaotic steps
// (reaction-diffusion) let that grow.
const LOOSE = {
  kuwahara: { over: 0.002, mean: 0.05 },
  oil_paint: { over: 0.002, mean: 0.05 },
  reaction_diffusion: { over: 0.15, mean: 3 }
};

function runWebgpu(cases) {
  const base = path.join(os.tmpdir(), 'omnifilter-webgpu-' + process.pid);
  fs.writeFileSync(base + '-in.json', JSON.stringify(cases.map((c) => Object.assign({}, c, {
    rgba: c.rgba.toString('base64')
  }))));
  return new Promise((resolve, reject) => {
    execFile(process.execPath,
      [path.join(__dirname, 'fixtures', 'webgpu_child.js'), base + '-in.json', base + '-out.json'],
      { env: Object.assign({}, process.env, { OMNIFILTER_DEVICE: '' }) },
      (err, stdout, stderr) => {
        fs.unlinkSync(base + '-in.json');
        if (err) return reject(new Error(err.message + stderr));
        const out = JSON.parse(fs.readFileSync(base + '-out.json', 'utf8'));
        fs.unlinkSync(base + '-out.json');
        if (out.error) return reject(new Error('WebGPU backend: ' + out.error));
        resolve(out);
      });
  });
}

describe('the WebGPU backend', function() {
  this.timeout(600000);
  const W = 61;
  const H = 47;
  const cases = [];
  var webgpu;

  before(async function() {
    // The comparison is with OpenCL, so it runs in an OpenCL test run.
    if (gpuFilters.backend !== 'opencl') this.skip();
    if (!hasDawn) {
      if (process.env.OMNIFILTER_REQUIRE_WEBGPU) throw new Error('The webgpu package is not installed');
      this.skip();
    }
    const small = testImage(W, H);
    for (const f of gpuFilters.list()) {
      const def = f.name;
      if (f.available === false || gpuFilters.plan === undefined) continue;
      // Neural styles run on ONNX Runtime, not as kernels.
      if (f.group === 'Neural style') continue;
      const variants = [{}];
      for (const p of f.params) {
        if (p.type === 'select') for (const o of p.options.slice(1)) variants.push({ [p.name]: o.value });
      }
      for (const params of variants) {
        cases.push({ label: def + ' ' + JSON.stringify(params), name: def, params: params, rgba: small, width: W, height: H });
      }
    }
    for (const p of stack.presets()) {
      cases.push({ label: 'preset ' + p.name, stack: p.stack, rgba: small, width: W, height: H });
    }
    for (const mode of stack.BLEND_MODES) {
      cases.push({
        label: 'blend ' + mode,
        stack: [{ tOption: 'invert' }, { tOption: 'sepia', blend: mode, amount: 60 }],
        rgba: small, width: W, height: H
      });
    }
    // Taller than a band (bilateral and median run 256 rows at a time).
    const tall = testImage(120, 700);
    cases.push({ label: 'banded bilateral', name: 'bilateral', params: {}, rgba: tall, width: 120, height: 700 });
    cases.push({ label: 'banded median', name: 'median', params: {}, rgba: tall, width: 120, height: 700 });
    webgpu = await runWebgpu(cases);
    // Shows in the GitHub Actions summary which GPU the backend had.
    if (process.env.GITHUB_ACTIONS) {
      console.log('::notice title=WebGPU backend device::' + webgpu.device.name + ' (' + webgpu.device.type + ')');
    }
  });

  it('runs on a WebGPU device', () => {
    expect(webgpu.device.platform).to.match(/WebGPU/);
    expect(webgpu.results.length).to.eql(cases.length);
  });

  it('gives the same results as OpenCL for every filter, preset and blend mode', async () => {
    const failures = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const result = webgpu.results[i];
      if (result.error) {
        failures.push(c.label + ': ' + result.error);
        continue;
      }
      const opencl = c.stack ?
        await stack.applyStack(stack.normalizeStack(c.stack), Buffer.from(c.rgba), c.width, c.height) :
        await gpuFilters.apply(c.name, Buffer.from(c.rgba), c.width, c.height, c.params);
      const d = compare(opencl, Buffer.from(result.pixels, 'base64'));
      const limits = LOOSE[c.name] || { over: 0.001, mean: 0.05 };
      if (d.over > limits.over || d.mean > limits.mean) failures.push(c.label + ': ' + JSON.stringify(d));
    }
    expect(failures).to.eql([]);
    expect(cases.length).to.be.above(70);
  });
});

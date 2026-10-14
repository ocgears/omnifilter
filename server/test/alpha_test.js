// Transparency: pixels have straight alpha, so a fully transparent pixel can
// hide any colour. Filters must not let that hidden colour show (dark halos
// round cut-outs), and must keep or sensibly filter alpha.
const expect = require('chai').expect;
const gpu = require(__dirname + '/../lib/gpu_filters');
const P = require(__dirname + '/../lib/filters/plan');
const ref = require(__dirname + '/reference');

const W = 64;
const H = 40;

// A disc of colour with a soft rim on a transparent background. hidden is the
// colour the transparent pixels hold: [r, g, b], or 'noise'.
function cutout(width, height, hidden, colour) {
  const noise = ref.randomImage(width, height, 5);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const d = Math.hypot(x - width / 2, y - height / 2) / (Math.min(width, height) * 0.35);
      const alpha = Math.round(255 * Math.min(1, Math.max(0, (1.15 - d) / 0.3)));
      const c = colour ? colour(x, y) : [60 + (noise[o] % 140), 80 + (noise[o + 1] % 120), 40 + (noise[o + 2] % 160)];
      let shown = c;
      if (!alpha) shown = hidden === 'noise' ? [noise[o], noise[o + 1], noise[o + 2]] : hidden;
      data.set(shown.concat(alpha), o);
    }
  }
  return data;
}

const alphaOf = (img) => Array.from(img).filter((v, i) => i % 4 === 3);

describe('transparency', function() {
  this.timeout(120000);

  // The anisotropic Kuwahara filter's edge directions come from the colours,
  // hidden ones included; that only steers its brush strokes.
  const skip = new Set(['oil_paint']);
  const filters = gpu.list().filter((f) => f.group !== 'Neural style' && f.available !== false && !skip.has(f.name));
  const black = cutout(W, H, [0, 0, 0]);
  const noisy = cutout(W, H, 'noise');

  it('hidden colours under transparent pixels never change what a filter shows', async () => {
    for (const f of filters) {
      const a = await gpu.apply(f.name, black, W, H, {});
      const b = await gpu.apply(f.name, noisy, W, H, {});
      const diff = ref.compare(ref.visible(a), ref.visible(b));
      expect(diff.max, f.name + ': ' + diff.count + ' bytes differ').to.equal(0);
    }
  });

  it('blurs a cut-out with no dark halo, softening its alpha edge', async () => {
    // Opaque white on the left, transparent black on the right.
    const w = 60;
    const h = 8;
    const src = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) if (p % w < w / 2) src.set([255, 255, 255, 255], p * 4);
    for (const [name, build] of [
      ['gaussian', (plan) => P.gaussian(plan, 3)],
      ['wide gaussian', (plan) => P.gaussian(plan, 30)],
      ['box', (plan) => P.boxBlur(plan, 4)],
      ['wide box', (plan) => P.boxBlur(plan, 60)]
    ]) {
      const plan = new P.Plan(w, h);
      build(plan);
      const out = await gpu.runPlan(src, w, h, plan);
      for (let p = 0; p < w * h; p++) {
        if (out[p * 4 + 3]) expect(Math.min(out[p * 4], out[p * 4 + 1], out[p * 4 + 2]), name).to.be.at.least(254);
      }
      const row = (x) => out[((h >> 1) * w + x) * 4 + 3];
      expect(row(w / 2 - 1), name + ': inside the edge').to.be.within(1, 254);
      expect(row(w / 2), name + ': outside the edge').to.be.within(1, 254);
    }
  });

  it('keeps cut-outs clean through the blur, motion blur and sharpening filters', async () => {
    const white = cutout(W, H, [0, 0, 0], () => [255, 255, 255]);
    for (const name of ['blur', 'box_blur', 'motion_blur', 'sharpen', 'unsharp', 'tilt_shift', 'bilateral',
      'kuwahara', 'median', 'pixelate', 'swirl', 'fisheye']) {
      const out = await gpu.apply(name, white, W, H, {});
      for (let o = 0; o < out.length; o += 4) {
        if (out[o + 3]) expect(Math.min(out[o], out[o + 1], out[o + 2]), name + ' at ' + o / 4).to.be.at.least(250);
      }
    }
  });

  it('pixelates a block on an alpha edge to its visible colour and mean alpha', async () => {
    // 8x8 blocks (10% of 80): left half of each opaque red, right half
    // transparent black.
    const src = new Uint8Array(80 * 80 * 4);
    for (let p = 0; p < 80 * 80; p++) if (p % 8 < 4) src.set([200, 30, 10, 255], p * 4);
    const out = await gpu.apply('pixelate', src, 80, 80, { block: 10 });
    for (let o = 0; o < out.length; o += 4) expect(Array.from(out.slice(o, o + 4))).to.eql([200, 30, 10, 128]);
  });

  it('keeps the alpha of halftone, oil paint, reaction-diffusion and dither', async () => {
    const expected = alphaOf(black);
    for (const [name, params] of [['halftone', {}], ['halftone', { style: 'mono' }], ['oil_paint', {}],
      ['reaction_diffusion', { iterations: 200 }], ['reaction_diffusion', { iterations: 200, colour: 'ink' }],
      ['crosshatch', {}], ['sobel', {}], ['edges', {}], ['dither', {}]]) {
      const out = await gpu.apply(name, black, W, H, params);
      expect(alphaOf(out), name + ' ' + JSON.stringify(params)).to.eql(expected);
    }
  });

  it('gives cell-based filters the mean alpha of each cell', async () => {
    const src = new Uint8Array(W * H * 4);
    for (let p = 0; p < W * H; p++) src.set([180, 90, 30, 128], p * 4);
    for (const name of ['stained_glass', 'ascii', 'pixelate']) {
      const out = await gpu.apply(name, src, W, H, {});
      for (const a of alphaOf(out)) expect(a, name).to.be.within(127, 129);
    }
  });

  it('leaves transparent pixels out of histograms', async () => {
    // Visible pixels span 100-150; transparent ones hide pure black and white.
    const src = new Uint8Array(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      const x = p % W;
      src.set(x < W / 2 ? [100 + x, 100 + x, 100 + x, 255] : [(x & 1) * 255, (x & 1) * 255, (x & 1) * 255, 0], p * 4);
    }
    const visible = (img) => Array.from(img).filter((v, i) => i % 4 === 0 && img[i + 3]);
    const levels = visible(await gpu.apply('auto_levels', src, W, H, { clip: 0 }));
    expect(Math.min.apply(null, levels)).to.equal(0);
    expect(Math.max.apply(null, levels)).to.equal(255);
    expectClose(await gpu.apply('auto_levels', src, W, H, { clip: 1 }), ref.autoLevels(src, W, H, 0.01, false), 2);
    expectClose(await gpu.apply('equalize', src, W, H, {}), ref.equalize(src, W, H, 1), 3);
    const clahe = visible(await gpu.apply('clahe', src, W, H, { strength: 8 }));
    expect(Math.max.apply(null, clahe) - Math.min.apply(null, clahe), 'CLAHE stretches the visible range')
      .to.be.above(50);
  });

  it('copes with a fully transparent image', async () => {
    const src = new Uint8Array(W * H * 4);
    for (let p = 0; p < W * H; p++) src.set([90, 120, 150, 0], p * 4);
    for (const name of ['equalize', 'auto_levels', 'clahe', 'stained_glass', 'pixelate', 'blur', 'median']) {
      const out = await gpu.apply(name, src, W, H, {});
      expect(Math.max.apply(null, alphaOf(out)), name).to.equal(0);
    }
  });
});

function expectClose(gpuOut, refOut, tolerance) {
  const diff = ref.compare(gpuOut, refOut);
  expect(diff.max, diff.count + ' bytes differ').to.be.at.most(tolerance);
}

'use strict';

const P = require('./plan');
const { Plan, buf, int, float, range, choice } = P;

const GROUP = 'Auto adjust';

// Adds a histogram pass over the source image and returns the buffer name
// (1024 ints: red, green, blue, luma), of the pixels that aren't fully
// transparent. Each work-group builds a histogram in local memory and merges
// it, so global atomics stay few.
function histogram(plan) {
  const hist = plan.buffer(1024 * 4, { zero: true });
  const groups = 64;
  plan.pass('histogram', [buf('src'), buf(hist), int(plan.width * plan.height)],
    { global: [256 * groups], local: [256] });
  return hist;
}

module.exports = [
  {
    name: 'auto_levels',
    label: 'Auto levels',
    group: GROUP,
    description: 'Stretches tones to use the full range; "auto colour" also removes colour casts.',
    params: [
      choice('mode', 'Mode', [['colour', 'Auto colour (per channel)'], ['contrast', 'Auto contrast (linked)']]),
      range('clip', 'Clip (%)', 0, 5, 0.5, 0.1)
    ],
    plan(w, h, p) {
      const plan = new Plan(w, h);
      const hist = histogram(plan);
      const params = plan.buffer(6 * 4);
      plan.pass('auto_levels_params', [buf(hist), buf(params), float(p.clip / 100),
        int(p.mode === 'contrast' ? 1 : 0)], { global: [3] });
      const out = plan.rgba();
      plan.pass('apply_levels', [buf('src'), buf(params), buf(out), int(w), int(h)]);
      plan.current = out;
      return plan;
    }
  },
  {
    name: 'equalize',
    label: 'Histogram equalization',
    group: GROUP,
    description: 'Spreads brightness levels evenly across the range, using an atomic histogram and a parallel scan.',
    params: [range('amount', 'Amount (%)', 0, 100, 100)],
    plan(w, h, p) {
      const plan = new Plan(w, h);
      const hist = histogram(plan);
      const lut = plan.buffer(257 * 4);
      plan.pass('equalize_lut', [buf(hist), buf(lut)], { global: [256], local: [256] });
      const out = plan.rgba();
      plan.pass('apply_luma_lut', [buf('src'), buf(lut), buf(out), int(w), int(h), float(p.amount / 100)]);
      plan.current = out;
      return plan;
    }
  },
  {
    name: 'clahe',
    label: 'Local contrast (CLAHE)',
    group: GROUP,
    description: 'Equalizes each region separately, with limits, then blends: dramatic on dull photos.',
    params: [
      range('strength', 'Strength (clip limit)', 1, 8, 2.5, 0.1),
      range('tiles', 'Tiles across', 2, 16, 8),
      range('amount', 'Amount (%)', 0, 100, 100)
    ],
    plan(w, h, p) {
      // Whole tiles: the buffers and the kernels' indexing must agree. Square
      // tiles, but no more than 64 down: a very tall, narrow photo would
      // otherwise get thousands, more workgroups than a GPU dispatches at once.
      const tilesX = Math.max(1, Math.min(Math.round(p.tiles), w));
      const tilesY = Math.max(1, Math.min(h, 64, Math.round(p.tiles * h / w)));
      const tiles = tilesX * tilesY;
      const plan = new Plan(w, h);
      const hists = plan.buffer(tiles * 256 * 4);
      const luts = plan.buffer(tiles * 256 * 4);
      plan.pass('clahe_hist', [buf('src'), buf(hists), int(w), int(h), int(tilesX), int(tilesY)],
        { global: [256 * tiles], local: [256] });
      plan.pass('clahe_lut', [buf(hists), buf(luts), float(p.strength)], { global: [256 * tiles], local: [256] });
      const out = plan.rgba();
      plan.pass('clahe_apply', [buf('src'), buf(luts), buf(out), int(w), int(h), int(tilesX), int(tilesY),
        float(p.amount / 100)]);
      plan.current = out;
      return plan;
    }
  }
];

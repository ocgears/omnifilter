'use strict';

const P = require('./plan');
const { Plan, buf, img, int, float, range, choice } = P;

const GROUP = 'Generative';

// Small deterministic PRNG, so the same photo always gives the same result.
function mulberry32(seed) {
  return function() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One seed per grid cell, jittered within the cell, so every pixel's nearest
// seed is within about two cells.
function jitteredSeeds(w, h, cell) {
  const random = mulberry32(12345);
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const seeds = new Int32Array(cols * rows * 2);
  let n = 0;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      seeds[n++] = Math.min(w - 1, Math.floor((gx + random()) * cell));
      seeds[n++] = Math.min(h - 1, Math.floor((gy + random()) * cell));
    }
  }
  return seeds;
}

// The reaction-diffusion grid: `detail` cells across (at most the image's
// width), keeping the image's shape, but never more than MAX_RD_SIDE cells
// along either side, so very tall images can't make a huge grid.
const MAX_RD_SIDE = 1024;
const MAX_RD_WORK = 3e9;
function gridSize(w, h, detail) {
  let gw = Math.max(8, Math.min(Math.round(detail), w));
  let gh = Math.max(8, Math.round(gw * h / w));
  const scale = Math.min(1, MAX_RD_SIDE / Math.max(gw, gh));
  gw = Math.max(8, Math.round(gw * scale));
  gh = Math.max(8, Math.round(gh * scale));
  return { width: gw, height: gh };
}

const REACTIONS = {
  coral: { feed: 0.0545, kill: 0.062 },
  maze: { feed: 0.029, kill: 0.057 },
  spots: { feed: 0.035, kill: 0.065 },
  worms: { feed: 0.078, kill: 0.061 }
};

module.exports = [
  {
    name: 'stained_glass',
    label: 'Stained glass',
    group: GROUP,
    description: 'Voronoi cells via the Jump Flooding Algorithm, filled with each cell\'s average colour (atomic sums).',
    params: [
      range('cell', 'Cell size (% of size)', 0.5, 10, 2.5, 0.1),
      range('lead', 'Lead width (% of size)', 0.05, 1, 0.2, 0.05)
    ],
    plan(w, h, p) {
      const cell = Math.max(3, P.px(w, h, p.cell));
      const seeds = jitteredSeeds(w, h, cell);
      const count = seeds.length / 2;
      const plan = new Plan(w, h);
      const seedBuf = plan.buffer(seeds.byteLength, { init: seeds });
      let mapA = plan.buffer(w * h * 4);
      let mapB = plan.buffer(w * h * 4);
      // Per cell: 64-bit sums of colour times alpha and of alpha, and a pixel
      // count, as 9 uints (see cell_accumulate).
      const sums = plan.buffer(count * 9 * 4, { zero: true });

      plan.pass('jfa_clear', [buf(mapA), int(w), int(h)]);
      plan.pass('jfa_plant', [buf(seedBuf), buf(mapA), int(w), int(h), int(count)], { global: [count] });
      // Nearest seeds are within ~2 cells, so the first jump only needs to span that.
      let step = 1;
      while (step < cell * 2) step *= 2;
      for (; step >= 1; step = Math.floor(step / 2)) {
        plan.pass('jfa_step', [buf(mapA), buf(mapB), buf(seedBuf), int(w), int(h), int(step)]);
        [mapA, mapB] = [mapB, mapA];
      }
      // One extra 1-pixel pass fixes JFA's rare mistakes.
      plan.pass('jfa_step', [buf(mapA), buf(mapB), buf(seedBuf), int(w), int(h), int(1)]);
      [mapA, mapB] = [mapB, mapA];

      plan.pass('cell_accumulate', [buf('src'), buf(mapA), buf(sums), int(w), int(h)]);
      const out = plan.rgba();
      plan.pass('stained_glass', [buf(mapA), buf(sums), buf(out), int(w), int(h),
        float(Math.max(1.5, P.px(w, h, p.lead)))]);
      plan.current = out;
      return plan;
    }
  },
  {
    name: 'reaction_diffusion',
    label: 'Reaction-diffusion',
    group: GROUP,
    description: 'A Gray-Scott chemical simulation, thousands of GPU steps, steered by the photo\'s brightness.',
    params: [
      choice('style', 'Pattern', [['coral', 'Coral'], ['maze', 'Maze'], ['spots', 'Spots'], ['worms', 'Worms']]),
      choice('colour', 'Colour', [['photo', 'Photo through pattern'], ['ink', 'Ink on paper']]),
      range('detail', 'Detail (grid width)', 150, 1000, 450, 10),
      range('iterations', 'Iterations', 200, 8000, 3000, 100)
    ],
    plan(w, h, p) {
      const grid = gridSize(w, h, p.detail);
      const gw = grid.width;
      const gh = grid.height;
      // Bounded work: at most MAX_RD_WORK cell updates in all.
      const iterations = Math.max(1, Math.min(p.iterations, Math.floor(MAX_RD_WORK / (gw * gh))));
      const reaction = REACTIONS[p.style];
      const plan = new Plan(w, h);
      let a = plan.buffer(gw * gh * 16);
      let b = plan.buffer(gw * gh * 16);
      const cells = { global: [gw, gh] };
      plan.pass('rd_init', [img('src'), buf(a), int(gw), int(gh), int(w), int(h),
        float(reaction.feed), float(reaction.kill), float(0.003), int(7)], cells);
      for (let n = 0; n < iterations; n++) {
        plan.pass('rd_step', [buf(a), buf(b), int(gw), int(gh), float(1.0), float(0.5), float(1.0)], cells);
        [a, b] = [b, a];
      }
      const out = plan.rgba();
      plan.pass('rd_render', [img(a, { width: gw, height: gh, format: 'rgba32f' }), img('src'), buf(out),
        int(w), int(h), int(gw), int(gh), int(p.colour === 'ink' ? 0 : 1)]);
      plan.current = out;
      return plan;
    }
  }
];

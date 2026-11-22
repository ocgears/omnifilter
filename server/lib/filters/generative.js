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

// Standard fractal starting points: type 0 is Mandelbrot, 1 Julia,
// 2 Burning Ship, 3 Tricorn (Mandelbar).
const FRACTAL_PRESETS = {
  mandelbrot: { type: 0, centerX: -0.5, centerY: 0.0, baseZoom: 1.0, cRe: -0.7, cIm: 0.27015 },
  seahorse: { type: 0, centerX: -0.74364, centerY: 0.13183, baseZoom: 32.0, cRe: -0.74364, cIm: 0.13183 },
  elephant: { type: 0, centerX: 0.28172, centerY: 0.57711, baseZoom: 24.0, cRe: 0.28172, cIm: 0.57711 },
  julia_spiral: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: -0.4, cIm: 0.6 },
  julia_rabbit: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: -0.123, cIm: 0.745 },
  julia_dragon: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: -0.8, cIm: 0.156 },
  julia_dendrite: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: 0.0, cIm: 1.0 },
  julia_siegel: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: -0.391, cIm: -0.587 },
  burning_ship: { type: 2, centerX: -0.45, centerY: -0.5, baseZoom: 0.9, cRe: -0.45, cIm: -0.5 },
  tricorn: { type: 3, centerX: -0.3, centerY: 0.0, baseZoom: 0.95, cRe: -0.3, cIm: 0.0 }
};

const FRACTAL_MODES = { overlay: 0, seeded: 1, standalone: 2 };
const FRACTAL_PALETTES = { cosmic: 0, electric: 1, fire: 2, emerald: 3 };

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
      // The nearest seeds are in mapB now.
      plan.pass('cell_accumulate', [buf('src'), buf(mapB), buf(sums), int(w), int(h)]);
      const out = plan.rgba();
      plan.pass('stained_glass', [buf(mapB), buf(sums), buf(out), int(w), int(h),
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
  },
  {
    name: 'fractal',
    label: 'Fractal explorer',
    group: GROUP,
    description: 'Mandelbrot, Julia, Burning Ship and Tricorn fractals on the GPU, overlaid on the photo, seeded from its colours, or explored from classic starting points.',
    params: [
      choice('mode', 'Mode', [
        ['overlay', 'Overlaid on photo'],
        ['seeded', 'Seeded with photo'],
        ['standalone', 'Fractal only']
      ], 'overlay'),
      choice('preset', 'Starting point', [
        ['mandelbrot', 'Mandelbrot set'],
        ['seahorse', 'Seahorse Valley'],
        ['elephant', 'Elephant Valley'],
        ['julia_spiral', 'Golden spiral (Julia)'],
        ['julia_rabbit', 'Douady\'s rabbit (Julia)'],
        ['julia_dragon', 'Lightning dragon (Julia)'],
        ['julia_dendrite', 'Dendrite (Julia)'],
        ['julia_siegel', 'Siegel disk (Julia)'],
        ['burning_ship', 'Burning Ship'],
        ['tricorn', 'Tricorn (Mandelbar)']
      ], 'mandelbrot'),
      choice('palette', 'Palette', [
        ['cosmic', 'Cosmic nebula'],
        ['electric', 'Electric blue'],
        ['fire', 'Solar fire'],
        ['emerald', 'Emerald']
      ], 'cosmic'),
      range('zoom', 'Zoom', -1, 14, 0, 0.1),
      range('pan_x', 'Move horizontal', -2, 2, 0, 0.0001),
      range('pan_y', 'Move vertical', -2, 2, 0, 0.0001),
      range('iterations', 'Detail (iterations)', 30, 300, 100, 10),
      range('blend_amount', 'Overlay strength (%)', 10, 100, 75, 5)
    ],
    plan(w, h, p) {
      const preset = FRACTAL_PRESETS[p.preset] || FRACTAL_PRESETS.mandelbrot;
      const effectiveZoom = preset.baseZoom * Math.pow(2, p.zoom);
      const scale = 3.0 / Math.max(effectiveZoom, 0.0001);
      const centerX = preset.centerX + p.pan_x;
      const centerY = preset.centerY + p.pan_y;
      const modeIndex = FRACTAL_MODES[p.mode] !== undefined ? FRACTAL_MODES[p.mode] : 0;
      const paletteIndex = FRACTAL_PALETTES[p.palette] !== undefined ? FRACTAL_PALETTES[p.palette] : 0;
      const plan = new Plan(w, h);
      plan.step('fractal',
        float(centerX),
        float(centerY),
        float(scale),
        float(preset.cRe),
        float(preset.cIm),
        int(preset.type),
        int(modeIndex),
        int(paletteIndex),
        int(p.iterations),
        float(p.blend_amount / 100),
        int(0)
      ).band(128);
      return plan;
    }
  }
];

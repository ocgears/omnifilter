'use strict';

const P = require('./plan');
const { Plan, buf, data, int, float, range, choice } = P;

const GROUP = 'Retro';

// Averages blocks of the current image into a small float4 buffer. Returns
// { name, blocksX }.
function blockAverage(plan, block) {
  const bx = Math.ceil(plan.width / block);
  const by = Math.ceil(plan.height / block);
  const avg = plan.buffer(bx * by * 16);
  plan.pass('block_average', [buf(plan.current), buf(avg), int(plan.width), int(plan.height),
    int(block), int(bx), int(by)], { global: [bx, by] });
  return { name: avg, blocksX: bx };
}

// Replaces the current image with block x block squares of average colour.
function pixelate(plan, block) {
  const avg = blockAverage(plan, block);
  const out = plan.scratch();
  plan.pass('pixelate_fill', [buf(avg.name), buf(out), int(plan.width), int(plan.height),
    int(block), int(avg.blocksX)]);
  plan.current = out;
  return plan;
}

// A tiny 8x8 bitmap font for the ASCII art filter (one byte per row, most
// significant bit on the left), sorted from sparse to dense ink.
const GLYPHS = [
  [0, 0, 0, 0, 0, 0, 0, 0], // space
  [0, 0, 0, 0, 0, 0x18, 0x18, 0], // .
  [0, 0x18, 0x18, 0, 0, 0x18, 0x18, 0], // :
  [0, 0, 0, 0x7e, 0x7e, 0, 0, 0], // -
  [0, 0, 0x7e, 0, 0, 0x7e, 0, 0], // =
  [0, 0x18, 0x18, 0x7e, 0x7e, 0x18, 0x18, 0], // +
  [0, 0x5a, 0x3c, 0x7e, 0x7e, 0x3c, 0x5a, 0], // *
  [0x24, 0x7e, 0x7e, 0x24, 0x24, 0x7e, 0x7e, 0x24], // #
  [0x62, 0x66, 0x0c, 0x18, 0x30, 0x66, 0x46, 0], // %
  [0x3c, 0x66, 0x6e, 0x6e, 0x6e, 0x60, 0x3e, 0], // @
  [0x7e, 0xff, 0xdb, 0xff, 0xff, 0xdb, 0xff, 0x7e] // a dense block to finish
].map((rows) => ({ rows: rows, ink: rows.reduce((n, r) => n + r.toString(2).replace(/0/g, '').length, 0) }))
  .sort((a, b) => a.ink - b.ink);
const GLYPH_DATA = new Uint8Array([].concat(...GLYPHS.map((g) => g.rows)));

module.exports = [
  {
    name: 'pixelate',
    label: 'Pixelate',
    group: GROUP,
    description: 'Big square pixels, each the average colour of its block.',
    params: [range('block', 'Block size (% of size)', 0.3, 10, 2, 0.1)],
    plan(w, h, p) {
      return pixelate(new Plan(w, h), Math.max(2, Math.round(P.px(w, h, p.block))));
    }
  },
  {
    name: 'dither',
    label: 'Ordered dither',
    group: GROUP,
    description: 'A Bayer threshold pattern fakes many colours with few, like old computers and consoles.',
    params: [
      choice('style', 'Style', [['gameboy', 'Game Boy'], ['colour', 'Few colours'], ['mono', 'Black & white']]),
      range('levels', 'Levels per channel', 2, 8, 2),
      range('pixel', 'Pixel size (% of size)', 0.05, 1.5, 0.3, 0.05)
    ],
    plan(w, h, p) {
      const pixel = Math.max(1, Math.round(P.px(w, h, p.pixel)));
      const plan = new Plan(w, h);
      if (pixel > 1) pixelate(plan, pixel);
      const mode = { colour: 0, mono: 1, gameboy: 2 }[p.style];
      return plan.step('dither', int(p.levels), int(pixel), int(mode));
    }
  },
  {
    name: 'halftone',
    label: 'Halftone',
    group: GROUP,
    description: 'Printing-press dots: cyan, magenta, yellow and black screens at different angles.',
    params: [
      range('cell', 'Dot size (% of size)', 0.3, 4, 0.9, 0.05),
      choice('style', 'Style', [['cmyk', 'CMYK colour'], ['mono', 'Black & white']])
    ],
    plan(w, h, p) {
      const cell = Math.max(3, P.px(w, h, p.cell));
      const plan = P.gaussian(new Plan(w, h), cell * 0.35);
      // The original goes along too, for its alpha. Each pixel samples the
      // photo 36 times, so a big one runs in bands.
      return plan.sample('halftone', float(cell), int(p.style === 'mono' ? 1 : 0), buf('src'), int(0))
        .band(256);
    }
  },
  {
    name: 'ascii',
    label: 'ASCII art',
    group: GROUP,
    description: 'Each tile becomes a character from a tiny bitmap font, chosen by brightness.',
    params: [
      range('cell', 'Character size (% of size)', 0.3, 4, 0.8, 0.05),
      choice('style', 'Style', [['colour', 'Colour on black'], ['terminal', 'Green terminal'], ['paper', 'Ink on paper']])
    ],
    plan(w, h, p) {
      const cell = Math.max(4, Math.round(P.px(w, h, p.cell)));
      const plan = new Plan(w, h);
      const avg = blockAverage(plan, cell);
      const out = plan.rgba();
      const mode = { colour: 0, terminal: 1, paper: 2 }[p.style];
      plan.pass('ascii_art', [buf(avg.name), data(GLYPH_DATA), buf(out), int(w), int(h), int(cell),
        int(avg.blocksX), int(GLYPHS.length), int(mode)]);
      plan.current = out;
      return plan;
    }
  }
];

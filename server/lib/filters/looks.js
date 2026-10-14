'use strict';

// Colour grades ("looks") applied through 3D lookup tables, plus vignette.
// The built-in looks are baked from the colour functions below. Any .cube
// file dropped into server/luts/ also appears as a look.

const path = require('path');
const P = require('./plan');
const { Plan, img3d, int, float, data, range } = P;
const lut = require('./lut');

const GROUP = 'Looks';
const LUT_DIR = path.join(__dirname, '..', '..', 'luts');

const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const saturate = (c, s) => {
  const l = luma(c);
  return c.map((v) => l + (v - l) * s);
};
// Contrast S-curve that keeps 0 and 1 fixed; s from 0 to 1.
const curve = (v, s) => v - s * Math.sin(2 * Math.PI * v) / (2 * Math.PI);
const curves = (c, s) => c.map((v) => curve(Math.min(1, Math.max(0, v)), s));

const LOOKS = [
  {
    name: 'look_teal_orange',
    label: 'Teal & orange',
    description: 'Blockbuster split-toning: teal shadows, warm highlights.',
    fn(c) {
      const l = luma(c);
      let o = [c[0] - 0.07 * (1 - l) + 0.08 * l, c[1] + 0.02 * (1 - l) + 0.02 * l, c[2] + 0.07 * (1 - l) - 0.09 * l];
      o = saturate(o, 1.15);
      return curves(o, 0.4);
    }
  },
  {
    name: 'look_warm_film',
    label: 'Warm film',
    description: 'Soft contrast, warm tones and lifted blacks.',
    fn(c) {
      let o = curves(c, 0.3);
      o = [o[0] * 1.05 + 0.02, o[1] * 1.0 + 0.01, o[2] * 0.9 + 0.03];
      o = o.map((v) => 0.04 + v * 0.94);
      return saturate(o, 0.9);
    }
  },
  {
    name: 'look_bleach_bypass',
    label: 'Bleach bypass',
    description: 'Desaturated and contrasty, like skipping the bleach step when developing film.',
    fn(c) {
      let o = mixc(c, [luma(c), luma(c), luma(c)], 0.55);
      o = curves(o, 0.75);
      return [o[0] * 0.98, o[1], o[2] * 1.03];
    }
  },
  {
    name: 'look_cross_process',
    label: 'Cross process',
    description: 'Slide film developed as negative: yellow highlights, blue shadows.',
    fn(c) {
      return [curve(c[0], 0.6), curve(c[1], 0.3) * 1.02, 0.22 + c[2] * 0.55];
    }
  },
  {
    name: 'look_faded_matte',
    label: 'Faded matte',
    description: 'Lifted blacks, softened whites and muted colour.',
    fn(c) {
      const l = luma(c);
      let o = c.map((v) => 0.1 + v * 0.82);
      o = saturate(o, 0.8);
      return [o[0] - 0.01 * (1 - l), o[1] + 0.02 * (1 - l), o[2] + 0.02 * (1 - l)];
    }
  }
];

function lutFilter(name, label, description, table) {
  return {
    name: name,
    label: label,
    group: GROUP,
    description: description,
    params: [range('amount', 'Amount (%)', 0, 100, 100)],
    plan(w, h, p) {
      const plan = new Plan(w, h);
      const name3d = plan.buffer(table.table.byteLength, { init: table.table });
      return plan.step('lut3d', img3d(name3d, table.size), int(table.size), float(p.amount / 100),
        data(new Float32Array(table.domain)));
    }
  };
}

// Any .cube files in server/luts/, as looks.
const cubeFilters = () => lut.loadCubeDir(LUT_DIR).map((c) =>
  lutFilter(c.name, c.table.title || c.base, 'Your LUT from server/luts/' + c.file + '.', c.table));

module.exports = LOOKS.map((look) => lutFilter(look.name, look.label, look.description, lut.bake(look.fn)))
  .concat(cubeFilters())
  .concat([{
    name: 'vignette',
    label: 'Vignette',
    group: GROUP,
    description: 'Darkens towards the corners.',
    params: [
      range('strength', 'Strength (%)', 0, 100, 60),
      range('radius', 'Radius (%)', 0, 100, 45),
      range('softness', 'Softness (%)', 5, 100, 50)
    ],
    plan: (w, h, p) => new Plan(w, h).step('vignette',
      float(p.strength / 100), float(p.radius / 100), float(p.softness / 100))
  }]);

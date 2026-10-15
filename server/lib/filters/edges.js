'use strict';

const P = require('./plan');
const { Plan, buf, data, int, float, range, choice } = P;
const M = require('./matrices');

const GROUP = 'Edges & relief';

module.exports = [
  {
    name: 'emboss',
    label: 'Emboss',
    group: GROUP,
    description: 'Relief from a directional 3x3 derivative, with a +128 bias so flat areas are grey.',
    params: [
      range('strength', 'Strength', 0.5, 4, 1.5, 0.1),
      range('angle', 'Light angle (degrees)', 0, 360, 135),
      choice('style', 'Style', [['grey', 'Grey stone'], ['colour', 'Colour relief']])
    ],
    plan(w, h, p) {
      const a = p.angle * Math.PI / 180;
      const weights = new Float32Array(9);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          weights[(dy + 1) * 3 + dx + 1] = p.strength * (dx * Math.cos(a) + dy * Math.sin(a));
        }
      }
      const plan = new Plan(w, h);
      if (p.style === 'colour') {
        weights[4] = 1;
        return P.convolve(plan, weights, 3, 3);
      }
      P.convolve(plan, weights, 3, 3, 128);
      return plan.step('color_matrix', data(M.grayscale(1)));
    }
  },
  {
    name: 'edges',
    label: 'Edge detect (Laplacian)',
    group: GROUP,
    description: 'The magnitude of a Laplacian kernel: bright wherever brightness changes sharply.',
    params: [
      range('strength', 'Strength', 1, 10, 3, 0.5),
      choice('style', 'Style', [['colour', 'Glowing colour'], ['white', 'White on black'], ['outline', 'Outline (black on white)']])
    ],
    plan(w, h, p) {
      const s = p.strength;
      const weights = new Float32Array([-s, -s, -s, -s, 8 * s, -s, -s, -s, -s]);
      // Smooth first so the kernel picks up edges rather than noise.
      const plan = P.gaussian(new Plan(w, h), Math.max(0.6, P.px(w, h, 0.05)));
      P.convolve(plan, weights, 3, 3, 0, true);
      // The smoothing shouldn't soften the outline.
      plan.step('restore_alpha', buf('src'));
      if (p.style === 'colour') return plan;
      plan.step('color_matrix', data(M.grayscale(1)));
      return p.style === 'outline' ? plan.step('color_matrix', data(M.invert(1))) : plan;
    }
  },
  {
    name: 'sobel',
    label: 'Sobel edges',
    group: GROUP,
    description: 'Brightness gradient in x and y; "neon" colours each edge by its direction.',
    params: [
      range('strength', 'Strength', 0.5, 6, 2, 0.1),
      choice('style', 'Style', [['neon', 'Neon (by direction)'], ['white', 'White on black'], ['ink', 'Ink on paper']])
    ],
    plan(w, h, p) {
      const mode = { white: 0, ink: 1, neon: 2 }[p.style];
      const plan = P.gaussian(new Plan(w, h), Math.max(0.6, P.px(w, h, 0.08)));
      return plan.step('sobel', float(p.strength), int(mode)).step('restore_alpha', buf('src'));
    }
  },
  {
    name: 'sketch',
    label: 'Pencil sketch',
    group: GROUP,
    description: 'Grey image colour-dodged with a blurred, inverted copy of itself.',
    params: [
      range('radius', 'Stroke width (% of size)', 0.1, 3, 0.6, 0.05),
      choice('style', 'Style', [['graphite', 'Graphite'], ['colour', 'Coloured pencil']])
    ],
    plan(w, h, p) {
      const plan = new Plan(w, h);
      const base = plan.rgba();
      plan.apply('color_matrix', 'src', base, data(p.style === 'colour' ? M.saturation(0.8) : M.grayscale(1)));
      const gray = plan.rgba();
      plan.apply('color_matrix', 'src', gray, data(M.multiply(M.invert(1), M.grayscale(1))));
      plan.current = gray;
      P.gaussian(plan, Math.max(0.5, P.px(w, h, p.radius)));
      const out = plan.rgba();
      plan.pass('color_dodge', [buf(base), buf(plan.current), buf(out), int(w), int(h)]);
      plan.current = out;
      return plan;
    }
  }
];

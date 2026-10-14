'use strict';

const P = require('./plan');
const { Plan, buf, data, int, float, range, choice } = P;

const M = require('./matrices');

const GROUP = 'Stylize';

// Painterly filters run at a reduced working size (the engine scales the
// photo down first and the result back up), so brush strokes are big enough
// to see and the heavy kernels stay fast on large photos.
const detail = range('detail', 'Detail (working size, px)', 600, 3000, 1600, 100);
const workingSize = (p) => p.detail;

function bilateral(plan, radius, sigmaR, iterations) {
  for (let n = 0; n < iterations; n++) {
    plan.step('bilateral', int(radius), float(Math.max(1, radius / 2)), float(sigmaR), int(0)).band(256);
  }
  return plan;
}

module.exports = [
  {
    name: 'bilateral',
    label: 'Smooth (bilateral)',
    group: GROUP,
    description: 'Edge-preserving smoothing, the basis of "beauty" filters.',
    params: [
      range('radius', 'Radius (px at working size)', 2, 10, 5),
      range('smoothing', 'Smoothing', 2, 40, 12),
      range('iterations', 'Iterations', 1, 5, 2),
      range('detail', 'Detail (working size, px)', 600, 4000, 2000, 100)
    ],
    // The radius is in pixels, so the cost grows with the image's area: big
    // photos are smoothed at the working size.
    workingSize: workingSize,
    plan: (w, h, p) => bilateral(new Plan(w, h), p.radius, p.smoothing / 100, p.iterations)
  },
  {
    name: 'cartoon',
    label: 'Cartoon',
    group: GROUP,
    description: 'Bilateral smoothing, softly banded brightness and ink lines from a difference of Gaussians.',
    params: [
      range('smoothing', 'Smoothing passes', 1, 6, 4),
      range('levels', 'Brightness levels', 3, 12, 4),
      range('lines', 'Line strength', 0, 100, 85),
      range('detail', 'Detail (working size, px)', 600, 3000, 1200, 100)
    ],
    workingSize: workingSize,
    plan(w, h, p) {
      const plan = bilateral(new Plan(w, h), 3, 0.1, p.smoothing);
      const smooth = plan.rgba();
      plan.apply('color_matrix', plan.current, smooth, data(M.saturation(1.3)));
      const colour = plan.rgba();
      plan.apply('quantize_luma', smooth, colour, int(p.levels), float(6));
      // Two blurs of the smoothed image for the difference of Gaussians.
      plan.current = smooth;
      P.gaussian(plan, 1.2);
      const narrow = plan.rgba();
      plan.apply('color_matrix', plan.current, narrow, data(M.identity()));
      P.gaussian(plan, 1.5);
      const ink = plan.rgba();
      plan.pass('dog_lines', [buf(narrow), buf(plan.current), buf(ink), int(w), int(h),
        float(0.002 + (100 - p.lines) / 100 * 0.02), float(60)]);
      const out = plan.rgba();
      plan.pass('cartoon_combine', [buf(colour), buf(ink), buf(out), int(w), int(h)]);
      plan.current = out;
      return plan;
    }
  },
  {
    name: 'kuwahara',
    label: 'Kuwahara',
    group: GROUP,
    description: 'Each pixel takes the mean of its least varied neighbouring square: a painterly look.',
    params: [range('radius', 'Radius (% of size)', 0.1, 1.5, 0.8, 0.05), detail],
    workingSize: workingSize,
    plan(w, h, p) {
      const r = Math.round(Math.min(16, Math.max(2, P.px(w, h, p.radius))));
      return new Plan(w, h).step('kuwahara', int(r), int(0)).band(128);
    }
  },
  {
    name: 'oil_paint',
    label: 'Oil paint',
    group: GROUP,
    description: 'Anisotropic Kuwahara: brush strokes that follow the edges in the picture.',
    params: [
      range('radius', 'Brush size (% of size)', 0.1, 1.5, 1.0, 0.05),
      range('sharpness', 'Sharpness', 2, 16, 8),
      detail
    ],
    workingSize: workingSize,
    plan(w, h, p) {
      const radius = Math.min(14, Math.max(2, P.px(w, h, p.radius)));
      const plan = new Plan(w, h);
      const tensor = plan.float4s();
      const smoothed = plan.float4s();
      plan.apply('structure_tensor', 'src', tensor);
      const g = P.gaussianWeights(2);
      plan.apply('convolve_f4', tensor, smoothed, data(g), int(g.length), int(1));
      plan.apply('convolve_f4', smoothed, tensor, data(g), int(1), int(g.length));
      plan.apply('tensor_orientation', tensor, smoothed);
      const out = plan.rgba();
      plan.pass('anisotropic_kuwahara', [buf('src'), buf(smoothed), buf(out), int(w), int(h),
        float(radius), float(p.sharpness), float(1), int(0)], { band: 128 });
      plan.current = out;
      return plan;
    }
  },
  {
    name: 'median',
    label: 'Median (denoise)',
    group: GROUP,
    description: 'Middle value of each channel in a window: removes speckles, keeps edges.',
    params: [
      range('radius', 'Radius (px at working size)', 1, 3, 1),
      range('detail', 'Detail (working size, px)', 1000, 8000, 4000, 100)
    ],
    workingSize: workingSize,
    plan: (w, h, p) => new Plan(w, h).step('median', int(p.radius), int(0)).band(256)
  },
  {
    name: 'crosshatch',
    label: 'Crosshatch',
    group: GROUP,
    description: 'Layers of diagonal pencil lines, denser in darker areas.',
    params: [
      range('spacing', 'Line spacing (% of size)', 0.2, 3, 0.6, 0.05),
      choice('style', 'Style', [['pencil', 'Pencil'], ['colour', 'Coloured ink']])
    ],
    plan(w, h, p) {
      const spacing = Math.max(3, P.px(w, h, p.spacing));
      const plan = P.gaussian(new Plan(w, h), spacing * 0.3);
      return plan.step('crosshatch', float(spacing), float(Math.max(1, spacing * 0.18)),
        int(p.style === 'colour' ? 1 : 0)).step('restore_alpha', buf('src'));
    }
  }
];


'use strict';

const P = require('./plan');
const { Plan, buf, data, int, float, range } = P;

const GROUP = 'Blur & sharpen';

module.exports = [
  {
    name: 'blur',
    label: 'Gaussian blur',
    group: GROUP,
    description: 'Smooth blur, run as two separable passes (rows then columns).',
    params: [range('radius', 'Radius (% of size)', 0.1, 5, 0.67, 0.01)],
    plan(w, h, p) {
      return P.gaussian(new Plan(w, h), Math.max(0.5, P.px(w, h, p.radius)));
    }
  },
  {
    name: 'box_blur',
    label: 'Box blur',
    group: GROUP,
    description: 'Averages a square around each pixel; cheaper and blockier than Gaussian.',
    params: [range('radius', 'Radius (% of size)', 0.1, 3, 0.5, 0.01)],
    plan(w, h, p) {
      return P.boxBlur(new Plan(w, h), Math.max(1, Math.round(P.px(w, h, p.radius))));
    }
  },
  {
    name: 'motion_blur',
    label: 'Motion blur',
    group: GROUP,
    description: 'Streaks along a direction, sampled with texture interpolation so any angle works.',
    params: [
      range('length', 'Length (% of size)', 0.5, 10, 3, 0.1),
      range('angle', 'Angle (degrees)', 0, 180, 0)
    ],
    plan(w, h, p) {
      const length = P.px(w, h, p.length);
      const a = p.angle * Math.PI / 180;
      // About one sample per pixel of streak; beyond 1024 they spread out, but
      // interpolation keeps the streak smooth.
      const samples = Math.min(1024, Math.max(2, Math.round(length)));
      return new Plan(w, h).sample('motion_blur',
        float(Math.cos(a) * length), float(Math.sin(a) * length), int(samples), int(0)).band(128);
    }
  },
  {
    name: 'sharpen',
    label: 'Sharpen',
    group: GROUP,
    description: 'A classic 3x3 sharpening kernel.',
    params: [range('amount', 'Amount (%)', 0, 300, 100)],
    plan(w, h, p) {
      const a = p.amount / 100;
      const weights = new Float32Array([0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0]);
      return P.convolve(new Plan(w, h), weights, 3, 3);
    }
  },
  {
    name: 'unsharp',
    label: 'Unsharp mask',
    group: GROUP,
    description: 'Sharpens by boosting the difference from a blurred copy, scaled to the image size.',
    params: [
      range('amount', 'Amount (%)', 0, 300, 150),
      range('radius', 'Radius (% of size)', 0.05, 2, 0.25, 0.01),
      range('threshold', 'Threshold', 0, 20, 0)
    ],
    plan(w, h, p) {
      const plan = P.gaussian(new Plan(w, h), Math.max(0.5, P.px(w, h, p.radius)));
      const blurred = plan.current;
      const out = plan.rgba();
      plan.pass('unsharp', [buf('src'), buf(blurred), buf(out), int(w), int(h),
        float(p.amount / 100), float(p.threshold / 100)]);
      plan.current = out;
      return plan;
    }
  },
  {
    name: 'tilt_shift',
    label: 'Tilt-shift',
    group: GROUP,
    description: 'Keeps a band sharp and blurs above and below it, so scenes look like miniatures.',
    params: [
      range('focus', 'Focus height (%)', 0, 100, 60),
      range('band', 'Sharp band (%)', 0, 50, 8),
      range('blur', 'Blur (% of size)', 0.2, 3, 1, 0.05),
      range('saturation', 'Saturation (%)', 50, 200, 135)
    ],
    plan(w, h, p) {
      const sigma = Math.max(0.5, P.px(w, h, p.blur));
      const plan = new Plan(w, h);
      P.gaussian(plan, sigma * 0.4);
      const blur1 = plan.rgba();
      plan.apply('color_matrix', plan.current, blur1, data(IDENTITY));
      P.gaussian(plan, sigma);
      const out = plan.rgba();
      plan.pass('tilt_shift', [buf('src'), buf(blur1), buf(plan.current), buf(out), int(w), int(h),
        float(p.focus / 100), float(p.band / 100), float(0.25), float(p.saturation / 100)]);
      plan.current = out;
      return plan;
    }
  }
];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);

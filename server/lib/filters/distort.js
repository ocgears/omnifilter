'use strict';

const P = require('./plan');
const { Plan, int, float, range, choice } = P;

const GROUP = 'Distort';

// The mirror kernel's modes, in its order.
const MIRROR_MODES = [['flip', 'Flip the whole photo'], ['first', 'Reflect the left / top half'],
  ['second', 'Reflect the right / bottom half']];

module.exports = [
  {
    name: 'swirl',
    label: 'Swirl',
    group: GROUP,
    description: 'Twists the image around its centre.',
    params: [
      range('angle', 'Angle (degrees)', -720, 720, 270),
      range('radius', 'Radius (% of size)', 10, 100, 50)
    ],
    plan: (w, h, p) => new Plan(w, h).sample('swirl', float(0.5), float(0.5),
      float(P.px(w, h, p.radius)), float(p.angle * Math.PI / 180))
  },
  {
    name: 'pinch_bulge',
    label: 'Pinch / bulge',
    group: GROUP,
    description: 'Magnifies (bulge) or shrinks (pinch) the centre.',
    params: [
      range('amount', 'Amount (- pinch, + bulge)', -100, 100, 60),
      range('radius', 'Radius (% of size)', 10, 100, 50)
    ],
    plan: (w, h, p) => new Plan(w, h).sample('pinch_bulge', float(0.5), float(0.5),
      float(P.px(w, h, p.radius)), float(p.amount / 100 * 0.9))
  },
  {
    name: 'fisheye',
    label: 'Fisheye',
    group: GROUP,
    description: 'Wide-angle lens look: big in the middle, squeezed at the edges.',
    params: [range('strength', 'Strength (%)', 1, 100, 60)],
    plan: (w, h, p) => new Plan(w, h).sample('fisheye', float(0.1 + p.strength / 100 * 2.6))
  },
  {
    name: 'ripple',
    label: 'Ripple',
    group: GROUP,
    description: 'Water rings or waves.',
    params: [
      range('amplitude', 'Amplitude (% of size)', 0.1, 3, 0.8, 0.05),
      range('wavelength', 'Wavelength (% of size)', 1, 20, 5, 0.5),
      choice('style', 'Style', [['water', 'Water drop'], ['waves', 'Waves']])
    ],
    plan: (w, h, p) => new Plan(w, h).sample('ripple', float(P.px(w, h, p.amplitude)),
      float(P.px(w, h, p.wavelength)), int(p.style === 'waves' ? 1 : 0))
  },
  {
    name: 'lens',
    label: 'Lens distortion',
    group: GROUP,
    description: 'Barrel (+) or pincushion (-) distortion, like a cheap wide or tele lens.',
    params: [range('amount', 'Amount', -50, 50, 25)],
    plan: (w, h, p) => new Plan(w, h).sample('lens_distortion', float(p.amount / 100))
  },
  {
    name: 'chromatic_aberration',
    label: 'Chromatic aberration',
    group: GROUP,
    description: 'Colour fringes towards the edges, as red and blue focus differently.',
    params: [range('amount', 'Amount (%)', 0, 3, 0.6, 0.05)],
    plan: (w, h, p) => new Plan(w, h).sample('chromatic_aberration', float(p.amount / 100))
  },
  {
    name: 'mirror',
    label: 'Mirror',
    group: GROUP,
    description: 'Flips the photo, or reflects one half of it onto the other.',
    params: [
      choice('direction', 'Direction', [['horizontal', 'Left and right'], ['vertical', 'Top and bottom'],
        ['both', 'Both']]),
      choice('mode', 'Mode', MIRROR_MODES)
    ],
    plan: (w, h, p) => new Plan(w, h).step('mirror', int(p.direction === 'vertical' ? 0 : 1),
      int(p.direction === 'horizontal' ? 0 : 1), int(MIRROR_MODES.findIndex((m) => m[0] === p.mode)))
  }
];

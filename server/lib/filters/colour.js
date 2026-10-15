'use strict';

const P = require('./plan');
const { Plan, data, int, float, range, choice } = P;
const M = require('./matrices');

const GROUP = 'Colour';

function matrixFilter(name, label, description, params, matrix) {
  return {
    name: name,
    label: label,
    group: GROUP,
    description: description,
    params: params,
    plan(w, h, p) {
      return new Plan(w, h).step('color_matrix', data(matrix(p)));
    }
  };
}

const amount = range('amount', 'Amount (%)', 0, 100, 100);

const DUOTONES = {
  ocean: [[0.02, 0.09, 0.25], [0.55, 0.95, 0.9]],
  sunset: [[0.25, 0.04, 0.3], [1.0, 0.72, 0.35]],
  mint: [[0.05, 0.2, 0.2], [0.85, 1.0, 0.85]],
  noir_gold: [[0.05, 0.05, 0.06], [1.0, 0.84, 0.45]]
};

module.exports = [
  matrixFilter('grayscale', 'Greyscale', 'Rec. 709 luma, via a colour matrix.',
    [amount], (p) => M.grayscale(p.amount / 100)),
  matrixFilter('sepia', 'Sepia', 'Warm brown old-photo tones.',
    [amount], (p) => M.sepia(p.amount / 100)),
  matrixFilter('invert', 'Invert', 'Photographic negative.',
    [amount], (p) => M.invert(p.amount / 100)),
  matrixFilter('saturation', 'Saturation', 'Makes colours more or less intense.',
    [range('saturation', 'Saturation (%)', 0, 300, 160)], (p) => M.saturation(p.saturation / 100)),
  matrixFilter('hue_rotate', 'Hue rotate', 'Spins every colour around the colour wheel.',
    [range('degrees', 'Degrees', -180, 180, 90)], (p) => M.hueRotate(p.degrees)),
  matrixFilter('brightness_contrast', 'Brightness / contrast', 'Shifts and stretches the tones.',
    [range('brightness', 'Brightness', -100, 100, 10), range('contrast', 'Contrast', -100, 100, 25)],
    (p) => M.multiply(M.brightness(p.brightness / 200), M.contrast(p.contrast / 100))),
  matrixFilter('channel_swap', 'Channel swap', 'Reassigns the red, green and blue channels.',
    [choice('order', 'Order', [['brg', 'BRG'], ['gbr', 'GBR'], ['bgr', 'BGR (swap red and blue)'],
      ['grb', 'GRB'], ['rbg', 'RBG']])], (p) => M.channelSwap(p.order)),
  matrixFilter('vintage', 'Vintage', 'Faded, warm, slightly sepia film.',
    [amount], (p) => M.vintage(p.amount / 100)),
  {
    name: 'gamma',
    label: 'Gamma',
    group: GROUP,
    description: 'Brightens or darkens the midtones while keeping black and white.',
    params: [range('gamma', 'Gamma', 0.2, 3, 1.6, 0.05)],
    plan: (w, h, p) => new Plan(w, h).step('gamma_correct', float(p.gamma))
  },
  {
    name: 'threshold',
    label: 'Threshold',
    group: GROUP,
    description: 'Pure black and white, split at a brightness level.',
    params: [range('level', 'Level (%)', 0, 100, 50)],
    plan: (w, h, p) => new Plan(w, h).step('threshold', float(p.level / 100))
  },
  {
    name: 'posterize',
    label: 'Posterize',
    group: GROUP,
    description: 'Reduces each channel to a few levels, like a screen print.',
    params: [range('levels', 'Levels', 2, 16, 4)],
    plan: (w, h, p) => new Plan(w, h).step('posterize', int(p.levels))
  },
  {
    name: 'solarize',
    label: 'Solarize',
    group: GROUP,
    description: 'Inverts tones above a threshold, like over-exposed film.',
    params: [range('level', 'Threshold (%)', 0, 100, 50)],
    plan: (w, h, p) => new Plan(w, h).step('solarize', float(p.level / 100))
  },
  {
    name: 'duotone',
    label: 'Duotone',
    group: GROUP,
    description: 'Maps brightness onto a gradient between two colours.',
    params: [choice('palette', 'Palette', [['ocean', 'Ocean'], ['sunset', 'Sunset'], ['mint', 'Mint'],
      ['noir_gold', 'Noir & gold']])],
    plan(w, h, p) {
      const pair = DUOTONES[p.palette];
      return new Plan(w, h).step('duotone', ...pair[0].map(float), ...pair[1].map(float));
    }
  }
];

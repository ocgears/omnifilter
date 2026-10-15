'use strict';

// Filter stacks: several filters applied one after another, each laid over
// the image it was applied to with a strength and a blend mode, the way
// adjustment layers work in a photo editor. The blending runs on the GPU
// (native/kernels/blend.cl).

const gpuFilters = require('./gpu_filters');
const { Plan, buf, int, float, range, choice } = require('./filters/plan');

const MAX_LAYERS = 8;

// In the order native/kernels/blend.cl numbers them.
const BLEND_MODES = [
  ['normal', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['soft_light', 'Soft light'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['difference', 'Difference'],
  ['color', 'Colour'],
  ['luminosity', 'Luminosity']
];

// The controls every layer has, besides its filter's own.
const LAYER_PARAMS = [
  range('amount', 'Strength (%)', 0, 100, 100),
  choice('blend', 'Blend', BLEND_MODES, 'normal')
];

// Ready-made stacks. Each layer is { tOption, params?, amount?, blend? };
// anything left out takes its default.
const PRESETS = [
  {
    name: 'comic',
    label: 'Comic book',
    description: 'Flat colours with inked outlines and a halftone print texture.',
    stack: [
      { tOption: 'bilateral', params: { radius: 6, smoothing: 20, iterations: 3 } },
      { tOption: 'posterize', params: { levels: 6 } },
      { tOption: 'sobel', params: { strength: 2.5, style: 'ink' }, blend: 'multiply' },
      { tOption: 'halftone', params: { cell: 0.6, style: 'cmyk' }, blend: 'multiply', amount: 35 }
    ]
  },
  {
    name: 'orton',
    label: 'Dreamy glow',
    description: 'The Orton effect: blurred copies screened and soft-lit over the sharp photo.',
    stack: [
      { tOption: 'brightness_contrast', params: { brightness: 15, contrast: 30 } },
      { tOption: 'blur', params: { radius: 2 }, blend: 'screen', amount: 70 },
      { tOption: 'blur', params: { radius: 1 }, blend: 'soft_light', amount: 60 }
    ]
  },
  {
    name: 'coloured_pencil',
    label: 'Coloured pencil',
    description: 'A colour sketch with graphite lines drawn over it.',
    stack: [
      { tOption: 'sketch', params: { radius: 1, style: 'colour' } },
      { tOption: 'sketch', params: { radius: 1, style: 'graphite' }, blend: 'multiply', amount: 70 }
    ]
  },
  {
    name: 'canvas_oil',
    label: 'Oil on canvas',
    description: 'Oil paint strokes with an embossed relief, as if lit from the side.',
    stack: [
      { tOption: 'oil_paint' },
      { tOption: 'emboss', params: { strength: 2.5, style: 'grey' }, blend: 'overlay' }
    ]
  },
  {
    name: 'neon_night',
    label: 'Neon night',
    description: 'Glowing neon edges screened over a darkened photo.',
    stack: [
      { tOption: 'brightness_contrast', params: { brightness: -45, contrast: 20 } },
      { tOption: 'sobel', params: { strength: 3, style: 'neon' }, blend: 'screen' }
    ]
  },
  {
    name: 'riso',
    label: 'Risograph',
    description: 'Two-ink duotone with a coarse halftone, like a riso print.',
    stack: [
      { tOption: 'brightness_contrast', params: { brightness: 25, contrast: 15 } },
      { tOption: 'duotone', params: { palette: 'sunset' } },
      { tOption: 'halftone', params: { cell: 0.7, style: 'mono' }, blend: 'soft_light', amount: 60 }
    ]
  },
  {
    name: 'gritty',
    label: 'Gritty detail',
    description: 'Strong local contrast and sharpening with a bleach-bypass grade.',
    stack: [
      { tOption: 'clahe', params: { strength: 4 } },
      { tOption: 'unsharp', params: { amount: 120, radius: 0.3 } },
      { tOption: 'look_bleach_bypass', amount: 70 }
    ]
  },
  {
    name: 'toy_camera',
    label: 'Toy camera',
    description: 'Tilt-shift miniature, cross-processed colour and a heavy vignette.',
    stack: [
      { tOption: 'tilt_shift' },
      { tOption: 'look_cross_process', amount: 60 },
      { tOption: 'vignette', params: { strength: 75, radius: 35 } }
    ]
  }
];

// Checks a stack from a request: a list of { tOption, params, amount, blend }.
// Returns the layers with every value filled in and clamped. Throws an Error
// whose message can go back to the client if the stack can't be used.
function normalizeStack(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LAYERS) {
    throw new Error('stack must be a list of 1 to ' + MAX_LAYERS + ' filters');
  }
  return raw.map((layer, i) => {
    if (layer === null || typeof layer !== 'object' || !gpuFilters.has(layer.tOption)) {
      throw new Error('stack item ' + (i + 1) + ' is not a known filter');
    }
    const look = gpuFilters.normalizeValues(LAYER_PARAMS, layer);
    return {
      tOption: layer.tOption,
      tParams: gpuFilters.normalizeParams(layer.tOption, layer.params),
      amount: look.amount,
      blend: look.blend
    };
  });
}

// Lays `top` (a filter's output) over `base` (its input) on the GPU.
function blend(top, base, width, height, mode, amount) {
  const plan = new Plan(width, height);
  const baseBuffer = plan.buffer(width * height * 4, { init: base });
  plan.step('blend_layers', buf(baseBuffer),
    int(BLEND_MODES.findIndex((m) => m[0] === mode)), float(amount / 100));
  return gpuFilters.runPlan(top, width, height, plan);
}

// Resolves with the RGBA pixels after every layer of a normalized stack.
async function applyStack(layers, rgba, width, height) {
  var image = rgba;
  for (const layer of layers) {
    const filtered = await gpuFilters.apply(layer.tOption, image, width, height, layer.tParams);
    image = layer.amount === 100 && layer.blend === 'normal' ?
      filtered : await blend(filtered, image, width, height, layer.blend, layer.amount);
  }
  return image;
}

// A broken preset should stop the server at startup, not fail a request later.
for (const preset of PRESETS) normalizeStack(preset.stack);

exports.MAX_LAYERS = MAX_LAYERS;
exports.LAYER_PARAMS = LAYER_PARAMS;
exports.BLEND_MODES = BLEND_MODES.map((m) => m[0]);
exports.presets = () => PRESETS;
exports.normalizeStack = normalizeStack;
exports.applyStack = applyStack;
exports.blend = blend;

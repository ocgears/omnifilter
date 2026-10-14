'use strict';

// Helpers for describing a filter as a pipeline of OpenCL kernel passes.
// A filter's plan() builds a Plan, which the native addon runs entirely on
// the device (see native/omnifilter.cpp for the format).

// Kernel argument constructors.
const buf = (name) => ({ buf: name });
const img = (name, options) => Object.assign({ img: name }, options);
const img3d = (name, size) => ({ img3d: name, size: size });
const int = (n) => ({ int: Math.round(n) });
const float = (x) => ({ float: x });
const data = (array) => ({ data: array });

class Plan {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.buffers = [];
    this.passes = [];
    this.current = 'src';
    this.count = 0;
    this.ping = null;
  }

  // Declares a device buffer and returns its name. options.init uploads a
  // typed array; options.zero fills it with zeros (e.g. for counters).
  buffer(bytes, options) {
    options = options || {};
    const name = 'b' + this.count++;
    this.buffers.push({ name: name, bytes: bytes, init: options.init, zero: !!options.zero });
    return name;
  }

  // A buffer for one RGBA image, the same size as the input.
  rgba() {
    return this.buffer(this.width * this.height * 4);
  }

  // A buffer of one float4 per pixel.
  float4s() {
    return this.buffer(this.width * this.height * 16);
  }

  // Adds a pass with explicit arguments. options.global / options.local set
  // the work sizes (default: one work-item per pixel).
  pass(kernel, args, options) {
    options = options || {};
    this.passes.push({ kernel: kernel, args: args, global: options.global, local: options.local, band: options.band });
    return this;
  }

  // Runs a standard image kernel, (src, dst, width, height, ...extra), from
  // one named buffer into another.
  apply(kernel, input, output) {
    const extra = Array.prototype.slice.call(arguments, 3);
    return this.pass(kernel, [buf(input), buf(output), int(this.width), int(this.height)].concat(extra));
  }

  // Runs a standard image kernel on the current image. Results alternate
  // between two scratch buffers, so a long chain of steps uses little memory;
  // copy anything you need to keep with apply() into your own buffer.
  step(kernel) {
    const out = this.scratch();
    this.apply.apply(this, [kernel, this.current, out].concat(Array.prototype.slice.call(arguments, 1)));
    this.current = out;
    return this;
  }

  // Like step(), but the kernel reads the current image as a texture:
  // (image2d src, dst, width, height, ...extra).
  sample(kernel) {
    const out = this.scratch();
    const extra = Array.prototype.slice.call(arguments, 1);
    this.pass(kernel, [img(this.current), buf(out), int(this.width), int(this.height)].concat(extra));
    this.current = out;
    return this;
  }

  // Launches the most recent pass in bands of `rows` rows (see the band
  // option in native/omnifilter.cpp), for kernels heavy enough to trip the
  // OS's GPU watchdog on big images.
  band(rows) {
    this.passes[this.passes.length - 1].band = rows;
    return this;
  }

  // The scratch buffer that isn't the current image. The second of the pair
  // is only allocated once a second step needs it.
  scratch() {
    if (!this.ping) this.ping = [null, null];
    const k = this.current === this.ping[0] ? 1 : 0;
    if (!this.ping[k]) this.ping[k] = this.rgba();
    return this.ping[k];
  }

  native() {
    return { buffers: this.buffers, passes: this.passes, output: this.current };
  }
}

// Normalized 1D Gaussian weights for a standard deviation in pixels.
function gaussianWeights(sigma) {
  const radius = Math.min(127, Math.ceil(sigma * 3));
  const weights = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    weights[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += weights[i + radius];
  }
  return weights.map((w) => w / sum);
}

// Arguments for the convolve kernel after (src, dst, width, height).
// premultiply filters alpha along with colour (for blurs); otherwise alpha is
// kept and transparent neighbours don't count (see convolve.cl).
const convolveArgs = (weights, kw, kh, bias, absolute, premultiply) =>
  [data(weights), int(kw), int(kh), float(bias || 0), int(absolute ? 1 : 0), int(premultiply ? 1 : 0), int(0)];

// Convolves the current image with a kw x kh weight matrix. bias is added
// afterwards (0-255 scale); with absolute, the magnitude is used.
function convolve(plan, weights, kw, kh, bias, absolute, premultiply) {
  return plan.step.apply(plan, ['convolve'].concat(convolveArgs(weights, kw, kh, bias, absolute, premultiply)))
    .band(256);
}

// A separable (rows, then columns) blur with 1D weights.
function separable(plan, weights) {
  convolve(plan, weights, weights.length, 1, 0, false, true);
  return convolve(plan, weights, 1, weights.length, 0, false, true);
}

// Runs a separable blur on a copy of the current image shrunk by `factor`
// (box-averaged), then scales the result back up bilinearly. Wide blurs are
// smooth enough that this looks the same as blurring at full size, at a
// fraction of the cost and with no limit on the radius. weights are the 1D
// weights at the small size.
function reduced(plan, factor, weights) {
  const w = plan.width;
  const h = plan.height;
  const sw = Math.ceil(w / factor);
  const sh = Math.ceil(h / factor);
  const a = plan.buffer(sw * sh * 4);
  const b = plan.buffer(sw * sh * 4);
  const small = { global: [sw, sh] };
  plan.pass('downsample_box', [buf(plan.current), buf(a), int(w), int(h), int(sw), int(sh), int(factor)], small);
  plan.pass('convolve', [buf(a), buf(b), int(sw), int(sh)].concat(convolveArgs(weights, weights.length, 1, 0, false, true)),
    small);
  plan.pass('convolve', [buf(b), buf(a), int(sw), int(sh)].concat(convolveArgs(weights, 1, weights.length, 0, false, true)),
    small);
  const out = plan.scratch();
  plan.apply('upsample_bilinear', a, out, int(sw), int(sh), int(factor));
  plan.current = out;
  return plan;
}

// Blurs wider than this (sigma in pixels) run on a reduced copy.
const MAX_DIRECT_SIGMA = 16;

// Blurs the current image with two separable passes (rows, then columns), in
// premultiplied alpha, so alpha edges soften too. Any sigma works.
function gaussian(plan, sigma) {
  if (sigma < 0.3) return plan;
  if (sigma <= MAX_DIRECT_SIGMA) return separable(plan, gaussianWeights(sigma));
  // Shrinking by f box-averages (variance (f^2 - 1) / 12) and scaling back up
  // bilinearly is a tent (variance f^2 / 6); the small blur makes up the rest.
  const f = Math.floor(sigma / 8);
  const small = Math.sqrt(Math.max(1, sigma * sigma - (f * f - 1) / 12 - f * f / 6)) / f;
  return reduced(plan, f, gaussianWeights(small));
}

// Box blurs wider than this radius (pixels) run on a reduced copy.
const MAX_DIRECT_BOX = 48;

// Averages a (2r + 1) square around each pixel, premultiplied.
function boxBlur(plan, r) {
  const box = (radius) => new Float32Array(2 * radius + 1).fill(1 / (2 * radius + 1));
  if (r <= MAX_DIRECT_BOX) return separable(plan, box(r));
  const f = Math.ceil(r / 24);
  return reduced(plan, f, box(Math.max(1, Math.round(((2 * r + 1) / f - 1) / 2))));
}

// Converts a size given as a percentage of the image's shorter side to pixels.
function px(width, height, percent) {
  return Math.min(width, height) * percent / 100;
}

// Filter parameter declarations; the client renders these as controls.
function range(name, label, min, max, defaultValue, step) {
  return { name: name, label: label, type: 'range', min: min, max: max, step: step || 1, default: defaultValue };
}

// options: [[value, label], ...]
function choice(name, label, options, defaultValue) {
  return {
    name: name,
    label: label,
    type: 'select',
    options: options.map((o) => ({ value: o[0], label: o[1] })),
    default: defaultValue === undefined ? options[0][0] : defaultValue
  };
}

// Rounds parameters declared with whole-number steps (and minimum) to whole
// numbers. Requests can send any number in range, e.g. tiles = 2.5, and
// buffer sizes, loop counts and kernel indexing must all agree on one value.
function roundWholeParams(declared, values) {
  const out = Object.assign({}, values);
  for (const p of declared || []) {
    if (p.type === 'range' && Number.isInteger(p.step) && Number.isInteger(p.min) &&
        typeof out[p.name] === 'number') {
      out[p.name] = Math.min(p.max, Math.max(p.min, Math.round(out[p.name])));
    }
  }
  return out;
}

module.exports = {
  range: range,
  choice: choice,
  roundWholeParams: roundWholeParams,
  Plan: Plan,
  buf: buf,
  img: img,
  img3d: img3d,
  int: int,
  float: float,
  data: data,
  gaussianWeights: gaussianWeights,
  convolve: convolve,
  gaussian: gaussian,
  boxBlur: boxBlur,
  px: px
};

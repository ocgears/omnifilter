'use strict';

// Neural style transfer: repaints the photo in the style of a famous artwork
// using small pretrained neural networks ("fast neural style", Johnson et
// al. 2016), from the ONNX model zoo.
//
// These don't run as OpenCL kernels. A neural network is millions of learned
// weights arranged as layers of convolutions; writing that by hand would mean
// re-implementing a deep-learning framework. Instead the models are stored in
// the standard ONNX format and run with ONNX Runtime, Microsoft's open-source
// inference engine, which picks fast implementations for the hardware.
//
// The filters only appear when the onnxruntime-node package (an optional
// dependency) loads and the model files have been downloaded with
// `npm run fetch-models`.

const fs = require('fs');
const path = require('path');
const sharp = require('../sharp');
const { range } = require('./plan');
const { makeSpatialDimsDynamic } = require('../onnx_dynamic');

const { STYLES, MODEL_DIR } = require('./neural_models');

const GROUP = 'Neural style';

let ort;
try {
  ort = require('onnxruntime-node');
} catch (e) {
  ort = null;
}

const sessions = new Map();

// The published models declare a fixed 224x224 input; patch that so they
// accept any size, then cache the session. A failed load isn't cached, so the
// next request tries again (e.g. after `npm run fetch-models`).
function session(file) {
  if (!sessions.has(file)) {
    const created = fs.promises.readFile(path.join(MODEL_DIR, file))
      .then((bytes) => exports.ort.InferenceSession.create(
        makeSpatialDimsDynamic(bytes, 'input1', 'output1'), { logSeverityLevel: 3 }));
    sessions.set(file, created);
    created.catch(() => {
      if (sessions.get(file) === created) sessions.delete(file);
    });
  }
  return sessions.get(file);
}

// Blending touches every pixel in JavaScript, which for a big photo takes long
// enough to hold up other requests, so it gives way every this many pixels.
const BLEND_CHUNK = 1 << 20;

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

async function stylize(file, rgba, width, height, params) {
  // Work at a reduced size: the network's cost grows with pixel count, and
  // the style's brush strokes are sized in network pixels anyway. Sizes are
  // multiples of 4 because the network downsamples twice by 2.
  const scale = Math.min(1, params.detail / Math.max(width, height));
  const ww = Math.max(16, Math.round(width * scale / 4) * 4);
  const wh = Math.max(16, Math.round(height * scale / 4) * 4);
  const small = await sharp(rgba, { raw: { width: width, height: height, channels: 4 } })
    .removeAlpha().resize(ww, wh, { fit: 'fill' }).raw().toBuffer();

  // Interleaved RGB bytes -> planar float tensor [1, 3, height, width], 0-255.
  const plane = ww * wh;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = small[i * 3];
    input[plane + i] = small[i * 3 + 1];
    input[2 * plane + i] = small[i * 3 + 2];
  }
  const s = await session(file);
  const result = await s.run({ input1: new exports.ort.Tensor('float32', input, [1, 3, wh, ww]) });
  const output = result.output1;
  const [, , oh, ow] = output.dims;
  const outPlane = ow * oh;
  const styled = Buffer.alloc(outPlane * 3);
  for (let i = 0; i < outPlane; i++) {
    for (let c = 0; c < 3; c++) {
      styled[i * 3 + c] = Math.min(255, Math.max(0, Math.round(output.data[c * outPlane + i])));
    }
  }

  // Back to full size, then blend with the original.
  const full = await sharp(styled, { raw: { width: ow, height: oh, channels: 3 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  const t = params.strength / 100;
  const out = Buffer.alloc(width * height * 4);
  const pixels = width * height;
  for (let begin = 0; begin < pixels; begin += BLEND_CHUNK) {
    if (begin) await yieldToEventLoop();
    const end = Math.min(pixels, begin + BLEND_CHUNK);
    for (let i = begin; i < end; i++) {
      for (let c = 0; c < 3; c++) {
        out[i * 4 + c] = Math.round(rgba[i * 4 + c] + (full[i * 3 + c] - rgba[i * 4 + c]) * t);
      }
      out[i * 4 + 3] = rgba[i * 4 + 3];
    }
  }
  return out;
}

exports = module.exports = !ort ? [] : STYLES
  .filter((style) => fs.existsSync(path.join(MODEL_DIR, style.file)))
  .map((style) => ({
    name: style.name,
    label: style.label,
    group: GROUP,
    description: 'Neural style transfer (fast neural style), run with ONNX Runtime.',
    params: [
      range('detail', 'Detail (working size, px)', 256, 1600, 1024, 32),
      range('strength', 'Strength (%)', 0, 100, 100)
    ],
    run: (job) => stylize(style.file, job.rgba, job.width, job.height, job.params)
  }));

// For tests: the ONNX Runtime module in use (replaceable with a stub), the
// session loader and its cache.
exports.ort = ort;
exports.session = session;
exports.sessions = sessions;

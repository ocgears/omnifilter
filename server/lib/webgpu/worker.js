'use strict';

// The WebGPU backend's own process (backend.js starts it). Dawn runs here
// rather than in the server: it's still a 0.x release, so a crash in it only
// takes this process down.
//
// Messages from the server: { id, type: 'init', setting } and
// { id, type: 'filter', rgba, width, height, plan }. Replies: { id, result }
// or { id, error: { message, code, status } }.

const { GpuEngine } = require('./engine');

// WebGPU doesn't say how much memory a GPU has, so plans are fitted to this
// many times the largest buffer it allows, unless OMNIFILTER_GPU_MEMORY_MB
// says otherwise.
const MEMORY_FROM_BUFFERS = 4;

// Dawn's GPU object (navigator.gpu's counterpart). It must stay referenced:
// once it's garbage-collected, Dawn tears the instance down under the device
// still using it, and the process crashes.
var gpu = null;
var engine = null;
var setting = 'auto';
// The set-up in progress, which filters wait for.
var starting = null;

// OMNIFILTER_DEVICE for WebGPU: 'auto', 'any' or 'gpu' (the high-performance
// adapter), 'low-power' (an integrated GPU, where there's a choice), or 'cpu'
// (a software adapter: SwiftShader or lavapipe). OMNIFILTER_WEBGPU_FLAGS
// passes Dawn's own options, comma-separated, e.g. backend=vulkan.
function adapterOptions(choice) {
  const s = String(choice || 'auto').trim().toLowerCase();
  if (s === 'cpu') return { forceFallbackAdapter: true };
  if (s === 'low-power') return { powerPreference: 'low-power' };
  if (['', 'auto', 'any', 'gpu'].includes(s)) return { powerPreference: 'high-performance' };
  throw new Error('OMNIFILTER_DEVICE=' + choice + " isn't a WebGPU choice: use auto, gpu, low-power or cpu");
}

// The device's description, in the shape the OpenCL addon's deviceInfo()
// has, so gpu_filters.js and device_choice.js can treat both the same.
function describe(e) {
  const info = e.adapterInfo;
  const limits = e.device.limits;
  const maxAlloc = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
  const memoryMb = Number(process.env.OMNIFILTER_GPU_MEMORY_MB);
  return {
    index: 0,
    name: info.description || [info.vendor, info.architecture].filter(Boolean).join(' ') ||
      'WebGPU adapter',
    vendor: info.vendor,
    type: info.fallback ? 'cpu' : 'gpu',
    platform: 'WebGPU (Dawn)',
    version: 'WebGPU',
    computeUnits: 0,
    maxWorkGroupSize: limits.maxComputeInvocationsPerWorkgroup,
    maxWorkItemSizes: [limits.maxComputeWorkgroupSizeX, limits.maxComputeWorkgroupSizeY,
      limits.maxComputeWorkgroupSizeZ],
    maxAllocBytes: maxAlloc,
    globalMemBytes: memoryMb > 0 ? memoryMb * 1024 * 1024 : maxAlloc * MEMORY_FROM_BUFFERS,
    // Images are storage buffers here, so any size a buffer can hold, as wide
    // as a dispatch can reach (8-pixel work-groups).
    imageSupport: true,
    image2dMaxWidth: limits.maxComputeWorkgroupsPerDimension * 8,
    image2dMaxHeight: limits.maxComputeWorkgroupsPerDimension * 8
  };
}

// Sets up the GPU and compiles every kernel; resolves with its description.
function setUp(choice) {
  starting = init(choice).finally(() => {
    starting = null;
  });
  return starting;
}

async function init(choice) {
  setting = choice;
  const dawn = require('webgpu');
  const flags = (process.env.OMNIFILTER_WEBGPU_FLAGS || '').split(',').map((f) => f.trim())
    .filter(Boolean);
  gpu = gpu || dawn.create(flags);
  const options = Object.assign({ bands: true }, adapterOptions(choice));
  var made = await GpuEngine.fromGpu(gpu, options);
  // Dawn offers software adapters (SwiftShader, lavapipe) only when asked;
  // with 'auto' or 'any', one is better than none.
  if (!made && ['', 'auto', 'any'].includes(String(choice || '').trim().toLowerCase())) {
    made = await GpuEngine.fromGpu(gpu, Object.assign(options, { forceFallbackAdapter: true }));
  }
  if (!made) throw new Error('No WebGPU adapter was found' + (flags.length ? ' with ' + flags.join(',') : ''));
  try {
    await made.prepare(GpuEngine.kernelNames());
  } catch (e) {
    made.destroy();
    throw e;
  }
  engine = made;
  return describe(made);
}

function gpuError(error) {
  const err = new Error('WebGPU error: ' + error.message);
  // Running out of memory is down to the image's size, not the server.
  if ((/out.of.memory/i).test(error.constructor && error.constructor.name || '') ||
      (/out of memory/i).test(error.message)) {
    err.message = 'The image is too large for this GPU';
    err.code = 'UNSUPPORTED';
    err.status = 400;
  }
  return err;
}

// Resolves with the filtered RGBA pixels.
async function filter(rgba, width, height, plan) {
  if (starting) await starting.catch(() => {});
  if (!engine || engine.lost) {
    if (engine) console.log('The WebGPU device was lost; setting it up again');
    engine = null;
    await setUp(setting);
  }
  const e = engine;
  const missing = GpuEngine.unsupported(plan);
  if (missing) throw new Error('The WebGPU backend has no ' + missing);
  const device = e.device;
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  var src = null;
  var out = null;
  var failure = null;
  try {
    src = e.createImage(width, height, rgba);
    out = e.run(plan, src);
  } catch (err) {
    failure = err;
  }
  const validation = await device.popErrorScope();
  const memory = await device.popErrorScope();
  if (failure || memory || validation) {
    e.release(src);
    if (out) e.release(out);
    throw failure || gpuError(memory || validation);
  }
  try {
    return await e.readPixels(out);
  } finally {
    e.release(src);
    e.release(out);
  }
}

process.on('message', (msg) => {
  const work = msg.type === 'init' ? setUp(msg.setting) :
    filter(msg.rgba, msg.width, msg.height, msg.plan);
  work.then((result) => process.send({ id: msg.id, result: result }), (err) => {
    process.send({ id: msg.id, error: { message: err.message, code: err.code, status: err.status } });
  });
});

// The server going away takes this process with it.
process.on('disconnect', () => process.exit(0));

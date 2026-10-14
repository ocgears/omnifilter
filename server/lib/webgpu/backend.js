'use strict';

// The WebGPU backend: runs the filter plans on the server's GPU through
// Dawn, Google's WebGPU engine, from the `webgpu` npm package, with the same
// WGSL kernels as the browser's live preview. WebGPU runs on Metal (macOS),
// Vulkan (Linux) and Direct3D 12 (Windows), so this covers GPUs that have no
// working OpenCL driver. Chosen with OMNIFILTER_BACKEND=webgpu; gpu_filters.js
// uses it the way it uses the OpenCL addon.
//
// Dawn runs in a process of its own (worker.js), started on first use and
// again if it stops: Dawn's Node bindings are still a 0.x release, and a
// crash there fails the filters it was running, not the server. Pixels and
// plans go back and forth as structured clones.
//
// `webgpu` is not a dependency (it's large, and only some servers want it):
// `npm install webgpu` adds it. Its macOS binary needs macOS 26 (webgpu@0.2
// runs on older macOS).

const { fork } = require('child_process');
const path = require('path');
const { GpuEngine } = require('./engine');

var worker = null;
var nextId = 1;
const pending = new Map();
var description = null;
var setting = 'auto';

function available() {
  try {
    require.resolve('webgpu');
    return true;
  } catch (e) {
    return false;
  }
}

function start() {
  const child = fork(path.join(__dirname, 'worker.js'), [], {
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });
  child.unref();
  child.on('message', (msg) => {
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id);
    // With nothing to wait for, the process doesn't keep the server's
    // event loop going (so scripts can finish).
    if (!pending.size) child.channel.unref();
    if (msg.error) waiting.reject(Object.assign(new Error(msg.error.message), msg.error));
    else waiting.resolve(msg.result);
  });
  child.on('exit', (code, signal) => {
    if (worker === child) worker = null;
    const why = 'The WebGPU process stopped (' + (signal || 'exit code ' + code) + ')';
    if (pending.size) console.log(why + '; it will be started again for the next filter');
    for (const call of pending.values()) call.reject(new Error(why));
    pending.clear();
  });
  return child;
}

function call(message) {
  if (!worker) {
    worker = start();
    // A new process sets the device up again before anything else.
    if (message.type !== 'init') call({ type: 'init', setting: setting }).catch(() => {});
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve, reject: reject });
    worker.channel.ref();
    worker.send(Object.assign({ id: id }, message));
  });
}

// Starts the WebGPU process, sets up the GPU and compiles every kernel.
// Resolves with the device's description, in the shape the OpenCL addon's
// deviceInfo() has.
async function init(choice) {
  if (!available()) {
    throw new Error('The WebGPU backend needs the webgpu package: run `npm install webgpu`');
  }
  setting = choice;
  description = await call({ type: 'init', setting: choice });
  return description;
}

// Resolves with a new Buffer of filtered RGBA pixels, like the addon's
// filter().
async function filter(rgba, width, height, plan) {
  if (rgba.length !== width * height * 4) {
    throw new Error('rgba must be width * height * 4 bytes (' + width + 'x' + height + ')');
  }
  const missing = GpuEngine.unsupported(plan);
  if (missing) throw new Error('The WebGPU backend has no ' + missing);
  // A view sends its whole ArrayBuffer, so send just its own bytes.
  const own = rgba.byteLength === rgba.buffer.byteLength ? rgba : new Uint8Array(rgba);
  const pixels = await call({ type: 'filter', rgba: own, width: width, height: height, plan: plan });
  // A Buffer of its own, starting at 0 like the addon's, so typed-array
  // views of it line up.
  const out = Buffer.alloc(pixels.byteLength);
  out.set(pixels);
  return out;
}

// Stops the WebGPU process (it stops by itself when the server does).
function stop() {
  if (worker) worker.kill();
  worker = null;
}

module.exports = {
  available: available,
  init: init,
  filter: filter,
  stop: stop,
  deviceInfo: () => description,
  kernels: () => GpuEngine.kernelNames()
};
